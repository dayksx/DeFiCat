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

export type EnsCommitmentInput = {
  label: string;
  durationSeconds: number;
  /**
   * Reuse a secret to make a retried commit idempotent: regenerating one would
   * mine a second commitment and waste gas. Omit it for a one-shot purchase.
   */
  secret?: string;
};

export type EnsCommitment = {
  label: string;
  durationSeconds: number;
  secret: string;
  commitment: string;
  commitmentTransactionHash: string;
};

export type EnsRegistrationFromCommitment = EnsRegistrationInput & {
  secret: string;
  commitmentTransactionHash: string;
};

export interface EnsRegistrarPort {
  quote(
    input: Omit<EnsRegistrationInput, 'maxTotalCostWei'>,
  ): Promise<EnsRegistrationQuote>;

  buy(input: EnsRegistrationInput): Promise<EnsRegistrationReceipt>;

  /**
   * Mines a commitment. Deliberately does not require the name to be available:
   * a scheduled purchase commits while the name is still registered, and only
   * reveals once it drops. Valid for MAX_COMMITMENT_AGE (24h on mainnet / Sepolia).
   */
  commit(input: EnsCommitmentInput): Promise<EnsCommitment>;

  /** Reveals a commitment mined earlier. Every failure here has already cost gas. */
  register(
    input: EnsRegistrationFromCommitment,
  ): Promise<EnsRegistrationReceipt>;

  /** Shortest allowed delay between commit and register. */
  minCommitmentAgeSeconds(): Promise<number>;
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
