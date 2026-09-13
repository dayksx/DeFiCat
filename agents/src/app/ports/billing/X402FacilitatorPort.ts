export const X402_FACILITATOR_PORT = Symbol("X402FacilitatorPort");

export type X402PaymentRequirements = {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: "application/json";
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
};

export type X402VerifyResult = {
  valid: boolean;
  payer?: string;
  reason?: string;
};

export type X402SettleResult = {
  txHash: string;
};

export interface X402FacilitatorPort {
  verify(input: {
    payload: unknown;
    requirements: X402PaymentRequirements;
  }): Promise<X402VerifyResult>;

  settle(input: {
    payload: unknown;
    requirements: X402PaymentRequirements;
  }): Promise<X402SettleResult>;
}