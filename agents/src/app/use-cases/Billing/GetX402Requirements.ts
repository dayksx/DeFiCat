import { DomainError } from "../../../domain/errors/DomainError.js";
import { offerFor } from "../../../domain/billing/ServiceCatalog.js";
import type { PaymentPolicy } from "../../../domain/billing/PaymentPolicy.js";
import type { ClockPort } from "../../ports/clock/ClockPort.js";
import type { PaymentStorePort } from "../../ports/billing/PaymentStorePort.js";
import type { X402PaymentRequirements } from "../../ports/billing/X402FacilitatorPort.js";
import { PaymentError } from "./PaymentError.js";
import type { PaymentIssuance } from "./PaymentIssuance.js";

export type X402RequirementsView = X402PaymentRequirements & {
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
        "UNKNOWN_SESSION",
        "Unknown or already used payment link",
      );
    }
    this.policy.assertPayable(session, this.clock.now());
    const offer = offerFor(session.sku);
    return {
      scheme: "exact",
      network: this.issuance.network,
      maxAmountRequired: session.amountAtomic.toString(),
      resource: session.uri,
      description: offer.label,
      mimeType: "application/json",
      payTo: session.payTo,
      asset: session.asset,
      maxTimeoutSeconds: 60,
      extra: {
        name: this.issuance.extraName,
        version: this.issuance.extraVersion,
      },
      payer: session.payer,
      nonce: session.nonce,
      issuedAt: session.issuedAt.toISOString(),
      expirationTime: session.expiresAt.toISOString(),
    };
  }
}