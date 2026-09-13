import {
  EnsSubnameRegistrationError,
  type EnsSubnameFailure,
  type EnsSubnamePort,
  type EnsSubnameQuote,
  type EnsSubnameReceipt,
} from '../../ports/ens/EnsSubnamePort.js';
import {
  EnsSubnamePolicy,
  type EnsSubnameRequest,
  type ValidatedEnsSubname,
} from '../../../domain/ens/EnsSubnamePolicy.js';
import { DomainError } from '../../../domain/errors/DomainError.js';
import {
  EnsSubnameError,
  type EnsSubnameErrorCode,
} from './EnsSubnameError.js';

const FAILURE_CODES: Record<EnsSubnameFailure, EnsSubnameErrorCode> = {
  UNAVAILABLE: 'SUBNAME_UNAVAILABLE',
  PARENT_NOT_OWNED: 'PARENT_NOT_OWNED',
  CHAIN_UNAVAILABLE: 'CHAIN_UNAVAILABLE',
  CREATE_FAILED: 'CREATE_FAILED',
};

export class CreateEnsSubname {
  constructor(
    private readonly subnames: EnsSubnamePort,
    private readonly policy: EnsSubnamePolicy,
  ) {}

  validate(request: EnsSubnameRequest): ValidatedEnsSubname {
    try {
      return this.policy.validate(request);
    } catch (error) {
      throw new EnsSubnameError(
        'INVALID_REQUEST',
        error instanceof DomainError
          ? error.message
          : 'Invalid ENS subname request',
        false,
        { cause: error },
      );
    }
  }

  async quote(request: EnsSubnameRequest): Promise<EnsSubnameQuote> {
    const valid = this.validate(request);
    try {
      return await this.subnames.inspect(valid);
    } catch (error) {
      throw translate(error);
    }
  }

  async execute(request: EnsSubnameRequest): Promise<EnsSubnameReceipt> {
    const valid = this.validate(request);
    const quote = await this.quote(valid);
    if (!quote.parentOwnedByAgent) {
      throw new EnsSubnameError(
        'PARENT_NOT_OWNED',
        `The agent does not own the wrapped parent ${valid.parentName}`,
      );
    }
    if (!quote.available) {
      throw new EnsSubnameError(
        'SUBNAME_UNAVAILABLE',
        `${valid.name} is already registered`,
      );
    }

    try {
      return await this.subnames.createSubname(valid);
    } catch (error) {
      throw translate(error);
    }
  }
}

function translate(error: unknown): EnsSubnameError {
  if (error instanceof EnsSubnameError) return error;
  if (error instanceof EnsSubnameRegistrationError) {
    return new EnsSubnameError(
      FAILURE_CODES[error.failure],
      error.message,
      error.failure === 'CHAIN_UNAVAILABLE',
      { cause: error },
    );
  }
  return new EnsSubnameError(
    'CREATE_FAILED',
    'The ENS subname operation failed unexpectedly',
    false,
    { cause: error },
  );
}
