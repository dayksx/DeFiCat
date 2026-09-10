import { DomainError } from '../../../domain/errors/DomainError.js';

export type EnsWatchErrorCode =
  | 'UNAUTHORIZED_CHAT'
  | 'ALREADY_WATCHED'
  | 'WATCH_NOT_FOUND'
  | 'WATCH_NOT_ACTIVE'
  | 'NOT_WATCH_OWNER'
  | 'DROP_DATE_UNKNOWN'
  | 'LOOKUP_UNAVAILABLE'
  | 'SCHEDULER_UNAVAILABLE';

/**
 * Failures specific to arming or cancelling a watch. Anything about the label,
 * the price, or the chain surfaces as `EnsPurchaseError` instead, since a
 * scheduled purchase validates and quotes through `PurchaseEnsName`.
 * Messages are safe to show to an end user.
 */
export class EnsWatchError extends DomainError {
  readonly code: EnsWatchErrorCode;
  readonly retryable: boolean;

  constructor(
    code: EnsWatchErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'EnsWatchError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}
