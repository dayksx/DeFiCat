import type { PaymentPayload } from '@x402/core/types';
import type { PaidIntent } from '../../../domain/billing/PaidIntent.js';
import { DomainError } from '../../../domain/errors/DomainError.js';
import { PaymentError } from '../Billing/PaymentError.js';
import type { IssueA2APaymentSession } from '../Billing/IssueA2APaymentSession.js';
import type { GetX402Requirements } from '../Billing/GetX402Requirements.js';
import type { PaidIntentOutcome } from '../Billing/FulfillPaidIntent.js';
import type { SettlePaymentAndFulfill } from '../Billing/SettlePaymentAndFulfill.js';
import type { PurchaseEnsName } from '../PurchaseEnsName/PurchaseEnsName.js';
import type { ServiceOffer } from '../../../domain/billing/ServiceCatalog.js';
import type { PaymentRequired } from '@x402/core/types';

export type A2AEnsSkill = 'buy' | 'schedule';

export type HandleA2AEnsSkillInput = {
  skill: A2AEnsSkill;
  name: string;
  years: number;
  resourceUrl: string;
  payload?: PaymentPayload;
};

export type HandleA2AEnsSkillResult =
  | {
      status: 'payment_required';
      offer: ServiceOffer;
      nonce: string;
      expiresAt: Date;
      paymentRequired: PaymentRequired;
    }
  | {
      status: 'paid';
      txHash: string;
      explorerUrl?: string;
      fulfillment: PaidIntentOutcome;
    };

export class HandleA2AEnsSkill {
  constructor(
    private readonly purchase: PurchaseEnsName,
    private readonly issue: IssueA2APaymentSession,
    private readonly requirements: GetX402Requirements,
    private readonly settle: SettlePaymentAndFulfill,
  ) {}

  async execute(
    input: HandleA2AEnsSkillInput,
  ): Promise<HandleA2AEnsSkillResult> {
    const valid = this.purchase.validate({
      label: input.name,
      years: input.years,
    });
    const quote = await this.purchase.quote(valid);
    const buyNow = quote.available && quote.withinBudget;

    if (input.skill === 'buy' && !buyNow) {
      throw new DomainError(
        buyNow === false && !quote.available
          ? `${quote.name} is already registered. Use the schedule skill after 0.1 USDC.`
          : `${quote.name} is above the agent budget. Use the schedule skill after 0.1 USDC.`,
      );
    }
    if (input.skill === 'schedule' && buyNow) {
      throw new DomainError(
        `${quote.name} is available within budget now. Use the buy skill after 0.01 USDC.`,
      );
    }

    const intent: PaidIntent =
      input.skill === 'buy'
        ? { type: 'ens.buy', label: valid.label, years: valid.years }
        : { type: 'ens.schedule', label: valid.label, years: valid.years };

    if (input.payload === undefined) {
      const invoice = await this.issue.execute({
        intent,
        resourceUrl: input.resourceUrl,
      });
      const view = await this.requirements.execute(invoice.nonce);
      return {
        status: 'payment_required',
        offer: invoice.offer,
        nonce: invoice.nonce,
        expiresAt: invoice.expiresAt,
        paymentRequired: view.paymentRequired,
      };
    }

    const token = sessionNonceFrom(input.payload);
    if (token === undefined) {
      throw new PaymentError(
        'INVALID_PAYMENT',
        'Payment payload is missing the session nonce',
      );
    }

    const settled = await this.settle.execute({
      token,
      payload: input.payload,
      awaitFulfillment: true,
    });
    if (settled.fulfillment === undefined) {
      throw new PaymentError(
        'SETTLEMENT_FAILED',
        'Payment settled but the ENS job returned no result',
      );
    }
    return {
      status: 'paid',
      txHash: settled.txHash,
      fulfillment: settled.fulfillment,
      ...(settled.explorerUrl !== undefined
        ? { explorerUrl: settled.explorerUrl }
        : {}),
    };
  }
}

export function sessionNonceFrom(payload: PaymentPayload): string | undefined {
  const extra = payload.accepted?.extra;
  if (extra !== undefined && typeof extra === 'object' && extra !== null) {
    const session = (extra as Record<string, unknown>).session;
    if (typeof session === 'string' && session.length >= 8) {
      return session;
    }
  }
  const resourceUrl = payload.resource?.url;
  if (typeof resourceUrl !== 'string' || resourceUrl.length === 0) {
    return undefined;
  }
  try {
    const session = new URL(resourceUrl).searchParams.get('session');
    return session !== null && session.length >= 8 ? session : undefined;
  } catch {
    return undefined;
  }
}
