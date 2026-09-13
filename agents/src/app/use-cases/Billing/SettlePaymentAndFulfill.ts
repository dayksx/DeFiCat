import type { PaymentPolicy } from '../../../domain/billing/PaymentPolicy.js';
import type { ClockPort } from '../../ports/clock/ClockPort.js';
import type { PaymentStorePort } from '../../ports/billing/PaymentStorePort.js';
import type { X402FacilitatorPort } from '../../ports/billing/X402FacilitatorPort.js';
import type { PaymentPayload } from '@x402/core/types';
import type { OutboundMessagingPort } from '../../ports/messaging/OutboundMessagingPort.js';
import { PaymentError } from './PaymentError.js';
import type { FulfillPaidIntent } from './FulfillPaidIntent.js';
import type { GetX402Requirements } from './GetX402Requirements.js';

export type SettlePaymentInput = {
  token: string;
  payload: PaymentPayload;
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
  ): Promise<{ paid: true; fulfilling: true }> {
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
  ): Promise<{ paid: true; fulfilling: true }> {
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
    await this.payments.saveReceipt({
      nonce: consumed.nonce,
      channel: consumed.channel,
      recipientId: consumed.recipientId,
      payer: consumed.payer,
      sku: consumed.sku,
      amountAtomic: consumed.amountAtomic,
      intent: consumed.intent,
      settlementTxHash: txHash,
      paidAt: this.clock.now(),
    });

    await this.messaging.send({
      channel: consumed.channel,
      recipientId: consumed.recipientId,
      message: this.policy.paidMessage(consumed),
    });

    void this.fulfill.execute(consumed.intent, consumed);
    return { paid: true, fulfilling: true };
  }
}
