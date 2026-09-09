export const ENS_REGISTRAR_PORT = Symbol('EnsRegistrarPort');

export type EnsRegistrationInput = {
  label: string;
  durationSeconds: number;
  maxTotalCostWei: string;
};

export type EnsRegistrationQuote = {
  name: string;
  owner: string;
  available: boolean;
  durationSeconds: number;
  baseWei: string;
  premiumWei: string;
  totalWei: string;
  valueWithSlippageWei: string;
};

export type EnsRegistrationReceipt = {
  name: string;
  owner: string;
  commitmentTransactionHash: string;
  registrationTransactionHash: string;
  totalPaidWei: string;
};

export interface EnsRegistrarPort {
  quote(
    input: Omit<EnsRegistrationInput, 'maxTotalCostWei'>,
  ): Promise<EnsRegistrationQuote>;

  buy(input: EnsRegistrationInput): Promise<EnsRegistrationReceipt>;
}

/** Failure modes every EnsRegistrarPort implementation must map its errors onto. */
export type EnsRegistrationFailure =
  | 'UNAVAILABLE'
  | 'OVER_BUDGET'
  | 'INSUFFICIENT_FUNDS'
  | 'CHAIN_UNAVAILABLE'
  | 'COMMIT_FAILED'
  | 'REGISTRATION_FAILED';

export class EnsRegistrationError extends Error {
  readonly failure: EnsRegistrationFailure;
  /** Set when a commitment was already mined: gas is spent even though nothing was registered. */
  readonly commitmentTransactionHash?: string;

  constructor(
    failure: EnsRegistrationFailure,
    message: string,
    options?: { cause?: unknown; commitmentTransactionHash?: string },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'EnsRegistrationError';
    this.failure = failure;
    this.commitmentTransactionHash = options?.commitmentTransactionHash;
  }
}
