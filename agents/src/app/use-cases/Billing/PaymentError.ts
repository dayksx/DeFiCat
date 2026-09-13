import { DomainError } from "../../../domain/errors/DomainError.js";

export type PaymentErrorCode =
  | "NOT_LINKED"
  | "UNKNOWN_SESSION"
  | "INVALID_PAYMENT"
  | "SETTLEMENT_FAILED";

export class PaymentError extends DomainError {
  readonly code: PaymentErrorCode;
  readonly retryable: boolean;

  constructor(
    code: PaymentErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "PaymentError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}