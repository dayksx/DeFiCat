import {
  EnsRegistrationError,
  type EnsRegistrarPort,
  type EnsRegistrationFailure,
  type EnsRegistrationQuote,
  type EnsRegistrationReceipt,
} from '../../ports/ens/EnsRegistrarPort.js';
import {
  EnsPurchasePolicy,
  type EnsPurchaseRequest,
  type ValidatedEnsPurchase,
} from '../../../domain/ens/EnsPurchasePolicy.js';
import { DomainError } from '../../../domain/errors/DomainError.js';
import {
  EnsPurchaseError,
  type EnsPurchaseErrorCode,
} from './EnsPurchaseError.js';

export type EnsPurchaseQuote = EnsRegistrationQuote & {
  years: number;
  withinBudget: boolean;
  maxBudgetWei: string;
};

type Translation = {
  code: EnsPurchaseErrorCode;
  retryable: boolean;
  message: (error: EnsRegistrationError) => string;
};

const REGISTRAR_FAILURES: Record<EnsRegistrationFailure, Translation> = {
  UNAVAILABLE: {
    code: 'NAME_UNAVAILABLE',
    retryable: false,
    message: (error) => error.message,
  },
  OVER_BUDGET: {
    code: 'OVER_BUDGET',
    retryable: false,
    message: (error) => error.message,
  },
  INSUFFICIENT_FUNDS: {
    code: 'INSUFFICIENT_FUNDS',
    retryable: false,
    message: (error) => error.message,
  },
  CHAIN_UNAVAILABLE: {
    code: 'CHAIN_UNAVAILABLE',
    retryable: true,
    message: () => 'The Ethereum node is unreachable right now',
  },
  COMMIT_FAILED: {
    code: 'PURCHASE_FAILED',
    retryable: true,
    message: () =>
      'The ENS commitment transaction did not go through, so nothing was registered',
  },
  REGISTRATION_FAILED: {
    code: 'COMMITTED_NOT_REGISTERED',
    retryable: false,
    message: (error) =>
      `${error.message}. Gas was spent on the commitment and the name is not registered`,
  },
};

export class PurchaseEnsName {
  constructor(
    private readonly registrar: EnsRegistrarPort,
    private readonly policy: EnsPurchasePolicy,
    private readonly maxPurchaseWei: string,
  ) {}

  /** Pure policy check, so callers can authorize a purchase before any network call. */
  validate(request: EnsPurchaseRequest): ValidatedEnsPurchase {
    try {
      return this.policy.validate(request);
    } catch (error) {
      const message =
        error instanceof DomainError
          ? error.message
          : 'Invalid ENS purchase request';
      throw new EnsPurchaseError('INVALID_REQUEST', message, { cause: error });
    }
  }

  /**
   * Reports price and availability. An unavailable name or an out-of-budget
   * price are outcomes, not errors, so the caller can explain them to the user.
   */
  async quote(request: EnsPurchaseRequest): Promise<EnsPurchaseQuote> {
    return this.quoteValidated(this.validate(request));
  }

  async execute(request: EnsPurchaseRequest): Promise<EnsRegistrationReceipt> {
    const valid = this.validate(request);
    const quote = await this.quoteValidated(valid);

    if (!quote.available) {
      throw new EnsPurchaseError(
        'NAME_UNAVAILABLE',
        `${quote.name} is already registered`,
      );
    }
    if (!quote.withinBudget) {
      throw new EnsPurchaseError(
        'OVER_BUDGET',
        `${quote.name} costs more than the agent budget`,
      );
    }

    try {
      return await this.registrar.buy({
        label: valid.label,
        durationSeconds: valid.durationSeconds,
        maxTotalCostWei: this.maxPurchaseWei,
      });
    } catch (error) {
      throw translateRegistrarError(error);
    }
  }

  private async quoteValidated(
    valid: ValidatedEnsPurchase,
  ): Promise<EnsPurchaseQuote> {
    let quote: EnsRegistrationQuote;
    try {
      quote = await this.registrar.quote({
        label: valid.label,
        durationSeconds: valid.durationSeconds,
      });
    } catch (error) {
      throw translateRegistrarError(error);
    }

    return {
      ...quote,
      years: valid.years,
      withinBudget: this.policy.isWithinBudget(
        quote.valueWithSlippageWei,
        this.maxPurchaseWei,
      ),
      maxBudgetWei: this.maxPurchaseWei,
    };
  }
}

function translateRegistrarError(error: unknown): EnsPurchaseError {
  if (error instanceof EnsPurchaseError) return error;

  if (error instanceof EnsRegistrationError) {
    const translation = REGISTRAR_FAILURES[error.failure] as
      Translation | undefined;
    if (translation !== undefined) {
      return new EnsPurchaseError(
        translation.code,
        translation.message(error),
        {
          retryable: translation.retryable,
          cause: error,
          commitmentTransactionHash: error.commitmentTransactionHash,
        },
      );
    }
  }

  return new EnsPurchaseError(
    'PURCHASE_FAILED',
    'The ENS registrar failed unexpectedly',
    { cause: error },
  );
}
