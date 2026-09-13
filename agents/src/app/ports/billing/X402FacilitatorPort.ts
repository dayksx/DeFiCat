import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';

export const X402_FACILITATOR_PORT = Symbol('X402FacilitatorPort');

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
    payload: PaymentPayload;
    requirements: PaymentRequirements;
  }): Promise<X402VerifyResult>;

  settle(input: {
    payload: PaymentPayload;
    requirements: PaymentRequirements;
  }): Promise<X402SettleResult>;
}
