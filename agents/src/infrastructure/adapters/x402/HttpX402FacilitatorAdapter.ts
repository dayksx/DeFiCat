import { PaymentError } from "../../../app/use-cases/Billing/PaymentError.js";
import type {
  X402FacilitatorPort,
  X402PaymentRequirements,
  X402SettleResult,
  X402VerifyResult,
} from "../../../app/ports/billing/X402FacilitatorPort.js";

export class HttpX402FacilitatorAdapter implements X402FacilitatorPort {
  constructor(private readonly baseUrl: string) {}

  async verify(input: {
    payload: unknown;
    requirements: X402PaymentRequirements;
  }): Promise<X402VerifyResult> {
    const body = await this.post("/verify", input);
    if (body.isValid !== true && body.valid !== true) {
      return {
        valid: false,
        reason:
          typeof body.invalidReason === "string"
            ? body.invalidReason
            : "Payment could not be verified",
      };
    }
    const payer =
      typeof body.payer === "string"
        ? body.payer
        : typeof body.invalidPayer === "string"
          ? undefined
          : undefined;
    return {
      valid: true,
      payer: typeof body.payer === "string" ? body.payer : undefined,
    };
  }

  async settle(input: {
    payload: unknown;
    requirements: X402PaymentRequirements;
  }): Promise<X402SettleResult> {
    const body = await this.post("/settle", input);
    const txHash =
      typeof body.transaction === "string"
        ? body.transaction
        : typeof body.txHash === "string"
          ? body.txHash
          : undefined;
    if (txHash === undefined) {
      throw new PaymentError(
        "SETTLEMENT_FAILED",
        "Facilitator did not return a transaction hash",
      );
    }
    return { txHash };
  }

  private async post(
    path: string,
    input: {
      payload: unknown;
      requirements: X402PaymentRequirements;
    },
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentHeader: input.payload,
        paymentRequirements: input.requirements,
      }),
    });
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new PaymentError(
        path === "/settle" ? "SETTLEMENT_FAILED" : "INVALID_PAYMENT",
        `Facilitator ${path} returned ${res.status}`,
      );
    }
    return json !== null && typeof json === "object"
      ? (json as Record<string, unknown>)
      : {};
  }
}