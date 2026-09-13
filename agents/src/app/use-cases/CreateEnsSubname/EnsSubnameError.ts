export type EnsSubnameErrorCode =
  | 'INVALID_REQUEST'
  | 'SUBNAME_UNAVAILABLE'
  | 'PARENT_NOT_OWNED'
  | 'CHAIN_UNAVAILABLE'
  | 'CREATE_FAILED';

export class EnsSubnameError extends Error {
  constructor(
    readonly code: EnsSubnameErrorCode,
    message: string,
    readonly retryable = false,
    options?: { cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'EnsSubnameError';
  }
}
