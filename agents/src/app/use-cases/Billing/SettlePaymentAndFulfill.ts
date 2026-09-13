import {
  A2A_CHANNEL,
  explorerTxUrl,
  type PaymentPolicy,
} from '../../../domain/billing/PaymentPolicy.js';
import type { ClockPort } from '../../ports/clock/ClockPort.js';
import type { PaymentStorePort } from '../../ports/billing/PaymentStorePort.js';
import type { X402FacilitatorPort } from '../../ports/billing/X402FacilitatorPort.js';
import type { PaymentPayload } from '@x402/core/types';
import type { OutboundMessagingPort } from '../../ports/messaging/OutboundMessagingPort.js';
import { PaymentError } from './PaymentError.js';
import {
  type FulfillPaidIntent,
  type PaidIntentOutcome,
} from './FulfillPaidIntent.js';
import type { GetX402Requirements } from './GetX402Requirements.js';

export type { PaidIntentOutcome };

export type SettlePaymentInput = {
  token: string;
  payload: PaymentPayload;
  awaitFulfillment?: boolean;
};

export type SettlePaymentResult = {
  paid: true;
  fulfilling: true;
  txHash: string;
  explorerUrl?: string;
  fulfillment?: PaidIntentOutcome;
};

export class SettlePaymentAndFulfill {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly payments: PaymentStorePort,
    private readonly facilitator: X402FacilitatorPort,
    private readonly clock: ClockPort,
    private readonly policy: PaymentPolicy,
    private readonly messaging: OutboundMessagingPort,
    private readonly getRequirements: GetX402Requirements,
    private readonly fulfill: FulfillPaidIntent,
  ) {}

  public async execute(
    input: SettlePaymentInput,
  ): Promise<SettlePaymentResult> {
    if (this.inFlight.has(input.token)) {
      throw new PaymentError(
        'INVALID_PAYMENT',
        'This payment is already being settled',
        { retryable: true },
      );
    }
    this.inFlight.add(input.token);
    try {
      return await this.executeExclusive(input);
    } finally {
      this.inFlight.delete(input.token);
    }
  }

  private async executeExclusive(
    input: SettlePaymentInput,
  ): Promise<SettlePaymentResult> {
    const session = await this.payments.findSession(input.token);
    if (session === undefined) {
      throw new PaymentError(
        'UNKNOWN_SESSION',
        'Unknown or already used payment link',
      );
    }
    this.policy.assertPayable(session, this.clock.now());

    const view = await this.getRequirements.execute(input.token);
    const requirements = view.paymentRequired.accepts[0];
    if (requirements === undefined) {
      throw new PaymentError(
        'INVALID_PAYMENT',
        'No supported payment option is available',
      );
    }

    const verified = await this.facilitator.verify({
      payload: input.payload,
      requirements,
    });
    if (!verified.valid || verified.payer === undefined) {
      throw new PaymentError(
        'INVALID_PAYMENT',
        verified.reason ?? 'Payment could not be verified',
      );
    }
    this.policy.assertPayer(session, verified.payer);

    let txHash: string;
    try {
      txHash = (
        await this.facilitator.settle({
          payload: input.payload,
          requirements,
        })
      ).txHash;
    } catch (error) {
      throw new PaymentError('SETTLEMENT_FAILED', 'Payment settlement failed', {
        cause: error,
        retryable: true,
      });
    }

    const consumed = await this.payments.consumeSession(session.nonce);
    const payer = verified.payer;
    const recipientId =
      consumed.channel === A2A_CHANNEL
        ? `${A2A_CHANNEL}:${payer.toLowerCase()}`
        : consumed.recipientId;
    const forFulfill = { ...consumed, payer, recipientId };

    await this.payments.saveReceipt({
      nonce: consumed.nonce,
      channel: consumed.channel,
      recipientId,
      payer,
      sku: consumed.sku,
      amountAtomic: consumed.amountAtomic,
      intent: consumed.intent,
      settlementTxHash: txHash,
      paidAt: this.clock.now(),
    });

    if (consumed.channel === 'telegram') {
      await this.messaging.send({
        channel: consumed.channel,
        recipientId: consumed.recipientId,
        message: this.policy.paidMessage(forFulfill, txHash),
      });
    }

    const explorerUrl = explorerTxUrl(consumed.chainId, txHash);
    const base = {
      paid: true as const,
      fulfilling: true as const,
      txHash,
      ...(explorerUrl !== undefined ? { explorerUrl } : {}),
    };

    if (input.awaitFulfillment === true) {
      return {
        ...base,
        fulfillment: await this.fulfill.execute(consumed.intent, forFulfill),
      };
    }

    void this.fulfill.execute(consumed.intent, forFulfill).catch(() => undefined);
    return base;
  }
}
