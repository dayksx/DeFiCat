import type { PaidIntent } from '../../../domain/billing/PaidIntent.js';
import { intentKey } from '../../../domain/billing/PaidIntent.js';
import type { PaymentPolicy } from '../../../domain/billing/PaymentPolicy.js';
import type { ServiceOffer } from '../../../domain/billing/ServiceCatalog.js';
import { offerFor } from '../../../domain/billing/ServiceCatalog.js';
import { skuFor } from '../../../domain/billing/PaidIntent.js';
import type { ClockPort } from '../../ports/clock/ClockPort.js';
import type { IdentityStorePort } from '../../ports/identity/IdentityStorePort.js';
import type { TokenGeneratorPort } from '../../ports/identity/TokenGeneratorPort.js';
import type { PaymentStorePort } from '../../ports/billing/PaymentStorePort.js';
import { PaymentError } from './PaymentError.js';
import type { PaymentIssuance } from './PaymentIssuance.js';

export type IssuePaymentSessionInput = {
  channel: string;
  recipientId: string;
  intent: PaidIntent;
};

export type IssuePaymentSessionResult = {
  offer: ServiceOffer;
  payUrl: string;
  expiresAt: Date;
  nonce: string;
};

export class IssuePaymentSession {
  constructor(
    private readonly identities: IdentityStorePort,
    private readonly payments: PaymentStorePort,
    private readonly tokens: TokenGeneratorPort,
    private readonly clock: ClockPort,
    private readonly policy: PaymentPolicy,
    private readonly issuance: PaymentIssuance,
  ) {}

  public async execute(
    input: IssuePaymentSessionInput,
  ): Promise<IssuePaymentSessionResult> {
    const binding = await this.identities.findBinding(
      input.channel,
      input.recipientId,
    );
    if (binding === undefined) {
      throw new PaymentError(
        'NOT_LINKED',
        'Sign in with Ethereum before paying for a service',
      );
    }

    const now = this.clock.now();
    const key = intentKey(input.intent);
    const open = await this.payments.findOpenSession(
      input.channel,
      input.recipientId,
      key,
    );
    if (open !== undefined && !this.policy.isExpired(open, now)) {
      return {
        offer: offerFor(open.sku),
        payUrl: open.uri,
        expiresAt: open.expiresAt,
        nonce: open.nonce,
      };
    }

    const session = this.policy.issue({
      nonce: this.tokens.nextSiweNonce(),
      channel: input.channel,
      recipientId: input.recipientId,
      payer: binding.address,
      intent: input.intent,
      now,
      payTo: this.issuance.payTo,
      chainId: this.issuance.chainId,
      asset: this.issuance.asset,
      uiOrigin: this.issuance.uiOrigin,
    });
    await this.payments.saveSession(session);
    return {
      offer: offerFor(skuFor(input.intent)),
      payUrl: session.uri,
      expiresAt: session.expiresAt,
      nonce: session.nonce,
    };
  }
}
