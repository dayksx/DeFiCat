import { DomainError } from '../../../domain/errors/DomainError.js';

export type EnsPurchaseErrorCode =
  | 'INVALID_REQUEST'
  | 'NAME_UNAVAILABLE'
  | 'OVER_BUDGET'
  | 'INSUFFICIENT_FUNDS'
  | 'CHAIN_UNAVAILABLE'
  | 'COMMITTED_NOT_REGISTERED'
  | 'PURCHASE_FAILED';

/**
 * Every failure `PurchaseEnsName` can produce. Messages are safe to show to an
 * end user: infrastructure details stay in `cause` and are never inlined.
 */
export class EnsPurchaseError extends DomainError {
  readonly code: EnsPurchaseErrorCode;
  readonly retryable: boolean;
  /** Set when a commitment was mined but registration never landed. */
  readonly commitmentTransactionHash?: string;

  constructor(
    code: EnsPurchaseErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      cause?: unknown;
      commitmentTransactionHash?: string;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'EnsPurchaseError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.commitmentTransactionHash = options.commitmentTransactionHash;
  }
}
