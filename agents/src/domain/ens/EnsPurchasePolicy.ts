import { DomainError } from '../errors/DomainError.js';

const YEAR_SECONDS = 365 * 24 * 60 * 60;

export type EnsPurchaseRequest = {
  label: string;
  years: number;
};

export type ValidatedEnsPurchase = {
  label: string;
  name: string;
  years: number;
  durationSeconds: number;
};

export class EnsPurchasePolicy {
  constructor(
    private readonly minYears = 1,
    private readonly maxYears = 5,
  ) {}

  /** Label rules alone, for callers that address an existing name without a duration. */
  normalizeLabel(label: string): { label: string; name: string } {
    const normalized = label.trim().toLowerCase().replace(/\.eth$/, '');

    if (normalized.includes('.')) {
      throw new DomainError('Only second-level .eth names can be purchased');
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(normalized)) {
      throw new DomainError(
        'ENS label must contain 3-63 lowercase letters, numbers, or inner hyphens',
      );
    }

    return { label: normalized, name: `${normalized}.eth` };
  }

  validate(request: EnsPurchaseRequest): ValidatedEnsPurchase {
    const { label, name } = this.normalizeLabel(request.label);

    if (
      !Number.isInteger(request.years) ||
      request.years < this.minYears ||
      request.years > this.maxYears
    ) {
      throw new DomainError(
        `ENS registration duration must be ${this.minYears}-${this.maxYears} years`,
      );
    }

    return {
      label,
      name,
      years: request.years,
      durationSeconds: request.years * YEAR_SECONDS,
    };
  }

  isWithinBudget(totalWei: string, maxWei: string): boolean {
    return BigInt(totalWei) <= BigInt(maxWei);
  }

  assertWithinBudget(totalWei: string, maxWei: string): void {
    if (!this.isWithinBudget(totalWei, maxWei)) {
      throw new DomainError('ENS registration price exceeds the agent budget');
    }
  }
}
