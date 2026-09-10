export const ENS_LOOKUP_PORT = Symbol("EnsLookupPort");

export type EnsDomainRecord = {
  name: string | null;
  labelName: string | null;
  labelhash: string | null;
  owner: string | null;
  registrant: string | null;
  wrappedOwner: string | null;
  resolvedAddress: string | null;
  /** ISO 8601 UTC. */
  createdAt: string | null;
  /** ISO 8601 UTC. Registration expiry: renewal is still possible after it. */
  expiryDate: string | null;
  /** ISO 8601 UTC. Expiry plus the 90-day grace period, after which the name is released. */
  gracePeriodEndDate: string | null;
};

export type EnsTransferRecord = {
  id: string;
  domainId: string;
  owner: string | null;
  blockNumber: number;
  transactionId: string;
};

export type EnsLookupResult = {
  domains: EnsDomainRecord[];
  transfers: EnsTransferRecord[];
};

export type EnsLookupQuery =
  | { kind: "name"; name: string }
  | { kind: "address"; address: string; limit?: number };

export interface EnsLookupPort {
  lookup(query: EnsLookupQuery): Promise<EnsLookupResult>;
}

export class EnsLookupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EnsLookupError";
  }
}
