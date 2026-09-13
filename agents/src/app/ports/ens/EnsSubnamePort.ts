export const ENS_SUBNAME_PORT = Symbol('EnsSubnamePort');

export type EnsSubnameInput = {
  name: string;
  label: string;
  parentName: string;
};

export type EnsSubnameQuote = {
  name: string;
  parentName: string;
  owner: string;
  available: boolean;
  parentOwnedByAgent: boolean;
  parentExpiry: Date | null;
};

export type EnsSubnameReceipt = {
  name: string;
  parentName: string;
  owner: string;
  expiry: Date | null;
  transactionHash: string;
};

export interface EnsSubnamePort {
  inspect(input: EnsSubnameInput): Promise<EnsSubnameQuote>;
  createSubname(input: EnsSubnameInput): Promise<EnsSubnameReceipt>;
}

export type EnsSubnameFailure =
  'UNAVAILABLE' | 'PARENT_NOT_OWNED' | 'CHAIN_UNAVAILABLE' | 'CREATE_FAILED';

export class EnsSubnameRegistrationError extends Error {
  constructor(
    readonly failure: EnsSubnameFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'EnsSubnameRegistrationError';
  }
}
