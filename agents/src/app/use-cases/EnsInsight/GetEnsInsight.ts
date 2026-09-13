import { EthereumAddress } from '../../../domain/identity/EthereumAddress.js';
import { DomainError } from '../../../domain/errors/DomainError.js';
import {
  EnsLookupError,
  type EnsLookupPort,
  type EnsLookupResult,
} from '../../ports/graph/EnsLookupPort.js';
import { EnsPurchasePolicy } from '../../../domain/ens/EnsPurchasePolicy.js';
import {
  PurchaseEnsName,
  type EnsPurchaseQuote,
} from '../PurchaseEnsName/PurchaseEnsName.js';

export type GetEnsInsightInput = {
  name?: string;
  address?: string;
  limit?: number;
};

export type EnsInsight = EnsLookupResult & {
  found: boolean;
  quote?: EnsPurchaseQuote & { schedulable: boolean };
};

const NAME_PATTERN = /^[a-z0-9.-]{3,255}$/;

export class GetEnsInsight {
  constructor(
    private readonly lookup: EnsLookupPort,
    private readonly purchase: PurchaseEnsName,
    private readonly policy: EnsPurchasePolicy,
  ) {}

  async execute(input: GetEnsInsightInput): Promise<EnsInsight> {
    const name = input.name?.trim().toLowerCase();
    const address = input.address?.trim();
    if (!name && !address) {
      throw new DomainError(
        'Provide an ENS name (e.g. vitalik.eth) or an Ethereum address',
      );
    }
    if (name !== undefined && name.length > 0 && !NAME_PATTERN.test(name)) {
      throw new DomainError('ENS name must be 3-255 letters, numbers, dots, or hyphens');
    }

    let result: EnsLookupResult;
    try {
      result = name
        ? await this.lookup.lookup({ kind: 'name', name })
        : await this.lookup.lookup({
            kind: 'address',
            address: EthereumAddress.of(address as string).value,
            limit: input.limit,
          });
    } catch (error) {
      throw new DomainError(
        error instanceof EnsLookupError
          ? 'ENS records are unreachable right now'
          : 'Could not look up ENS data',
        { cause: error },
      );
    }

    const quote = await this.quoteIfSecondLevel(name);
    return {
      found: result.domains.length > 0,
      ...result,
      ...(quote !== undefined ? { quote } : {}),
    };
  }

  private async quoteIfSecondLevel(
    name: string | undefined,
  ): Promise<(EnsPurchaseQuote & { schedulable: boolean }) | undefined> {
    if (name === undefined) return undefined;
    let label: string;
    try {
      label = this.policy.normalizeLabel(name).label;
    } catch {
      return undefined;
    }
    try {
      const quote = await this.purchase.quote({ label, years: 1 });
      return {
        ...quote,
        schedulable: !quote.available || !quote.withinBudget,
      };
    } catch {
      return undefined;
    }
  }
}
