import type { PaidIntent } from '../../../domain/billing/PaidIntent.js';
import {
  A2A_CHANNEL,
  A2A_OPEN_PAYER,
  type PaymentPolicy,
} from '../../../domain/billing/PaymentPolicy.js';
import { offerFor, type ServiceOffer } from '../../../domain/billing/ServiceCatalog.js';
import { skuFor } from '../../../domain/billing/PaidIntent.js';
import type { ClockPort } from '../../ports/clock/ClockPort.js';
import type { TokenGeneratorPort } from '../../ports/identity/TokenGeneratorPort.js';
import type { PaymentStorePort } from '../../ports/billing/PaymentStorePort.js';
import type { PaymentIssuance } from './PaymentIssuance.js';

export type IssueA2APaymentSessionInput = {
  intent: PaidIntent;
  resourceUrl: string;
};

export type IssueA2APaymentSessionResult = {
  offer: ServiceOffer;
  nonce: string;
  expiresAt: Date;
  payUrl: string;
};

export class IssueA2APaymentSession {
  constructor(
    private readonly payments: PaymentStorePort,
    private readonly tokens: TokenGeneratorPort,
    private readonly clock: ClockPort,
    private readonly policy: PaymentPolicy,
    private readonly issuance: PaymentIssuance,
  ) {}

  async execute(
    input: IssueA2APaymentSessionInput,
  ): Promise<IssueA2APaymentSessionResult> {
    const nonce = this.tokens.nextSiweNonce();
    const session = this.policy.issue({
      nonce,
      channel: A2A_CHANNEL,
      recipientId: `${A2A_CHANNEL}:${nonce}`,
      payer: A2A_OPEN_PAYER,
      intent: input.intent,
      now: this.clock.now(),
      payTo: this.issuance.payTo,
      chainId: this.issuance.chainId,
      asset: this.issuance.asset,
      uiOrigin: this.issuance.uiOrigin,
      uri: resourceUrlWithSession(input.resourceUrl, nonce),
    });
    await this.payments.saveSession(session);
    return {
      offer: offerFor(skuFor(input.intent)),
      nonce: session.nonce,
      expiresAt: session.expiresAt,
      payUrl: session.uri,
    };
  }
}

function resourceUrlWithSession(resourceUrl: string, nonce: string): string {
  const url = new URL(resourceUrl);
  url.searchParams.set('session', nonce);
  return url.toString();
}
