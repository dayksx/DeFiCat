import { offerFor } from '../../../domain/billing/ServiceCatalog.js';
import { A2A_CHANNEL, type PaymentPolicy } from '../../../domain/billing/PaymentPolicy.js';
import type { ClockPort } from '../../ports/clock/ClockPort.js';
import type { PaymentStorePort } from '../../ports/billing/PaymentStorePort.js';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { PaymentError } from './PaymentError.js';
import type { PaymentIssuance } from './PaymentIssuance.js';

export type X402RequirementsView = {
  paymentRequired: PaymentRequired;
  payer: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
};

export class GetX402Requirements {
  constructor(
    private readonly payments: PaymentStorePort,
    private readonly clock: ClockPort,
    private readonly policy: PaymentPolicy,
    private readonly issuance: PaymentIssuance,
  ) {}

  public async execute(token: string): Promise<X402RequirementsView> {
    const session = await this.payments.findSession(token);
    if (session === undefined) {
      throw new PaymentError(
        'UNKNOWN_SESSION',
        'Unknown or already used payment link',
      );
    }
    this.policy.assertPayable(session, this.clock.now());
    const offer = offerFor(session.sku);
    const extra: Record<string, string> = {
      name: this.issuance.extraName,
      version: this.issuance.extraVersion,
      assetTransferMethod: 'eip3009',
    };
    if (session.channel === A2A_CHANNEL) {
      extra.session = session.nonce;
    }
    const accepted: PaymentRequirements = {
      scheme: 'exact',
      network: this.issuance.network,
      amount: session.amountAtomic.toString(),
      payTo: session.payTo,
      asset: session.asset,
      maxTimeoutSeconds: 60,
      extra,
    };
    return {
      paymentRequired: {
        x402Version: 2,
        resource: {
          url: session.uri,
          description: offer.label,
          mimeType: 'application/json',
        },
        accepts: [accepted],
      },
      payer: session.payer,
      nonce: session.nonce,
      issuedAt: session.issuedAt.toISOString(),
      expirationTime: session.expiresAt.toISOString(),
    };
  }
}
