import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../../domain/errors/DomainError.js';
import { EnsPurchasePolicy } from '../../../domain/ens/EnsPurchasePolicy.js';
import type {
  EnsLookupPort,
  EnsLookupResult,
} from '../../ports/graph/EnsLookupPort.js';
import { PurchaseEnsName } from '../PurchaseEnsName/PurchaseEnsName.js';
import type {
  EnsRegistrarPort,
  EnsRegistrationQuote,
  EnsRegistrationReceipt,
} from '../../ports/ens/EnsRegistrarPort.js';
import { GetEnsInsight } from './GetEnsInsight.js';

const YEAR_SECONDS = 365 * 24 * 60 * 60;

function lookupResult(): EnsLookupResult {
  return {
    domains: [
      {
        name: 'vitalik.eth',
        labelName: 'vitalik',
        labelhash: null,
        owner: '0x1',
        registrant: null,
        wrappedOwner: null,
        resolvedAddress: '0x2',
        createdAt: null,
        expiryDate: '2026-01-01T00:00:00.000Z',
        gracePeriodEndDate: '2026-04-01T00:00:00.000Z',
      },
    ],
    transfers: [],
  };
}

function registrarOf(
  quote: Partial<EnsRegistrationQuote> = {},
): EnsRegistrarPort {
  return {
    quote: vi.fn(async () => ({
      name: 'vitalik.eth',
      owner: '0x1',
      available: false,
      durationSeconds: YEAR_SECONDS,
      baseWei: '100',
      premiumWei: '0',
      totalWei: '100',
      valueWithSlippageWei: '105',
      ...quote,
    })),
    buy: vi.fn(async (): Promise<EnsRegistrationReceipt> => {
      throw new Error('insight must not buy');
    }),
    commit: vi.fn(async () => {
      throw new Error('not used');
    }),
    register: vi.fn(async (): Promise<EnsRegistrationReceipt> => {
      throw new Error('not used');
    }),
    minCommitmentAgeSeconds: vi.fn(async () => 60),
  };
}

function useCaseOf(lookup: EnsLookupPort, quote?: Partial<EnsRegistrationQuote>) {
  const policy = new EnsPurchasePolicy();
  return new GetEnsInsight(
    lookup,
    new PurchaseEnsName(registrarOf(quote), policy, '1000'),
    policy,
  );
}

describe('GetEnsInsight', () => {
  it('looks up a name and attaches a 2LD quote', async () => {
    const lookup: EnsLookupPort = {
      lookup: vi.fn(async () => lookupResult()),
    };
    const insight = await useCaseOf(lookup).execute({ name: 'Vitalik.eth' });

    expect(insight.found).toBe(true);
    expect(insight.domains[0]?.name).toBe('vitalik.eth');
    expect(insight.quote).toMatchObject({
      available: false,
      schedulable: true,
      years: 1,
    });
    expect(lookup.lookup).toHaveBeenCalledWith({
      kind: 'name',
      name: 'vitalik.eth',
    });
  });

  it('looks up an address without quoting a purchase', async () => {
    const lookup: EnsLookupPort = {
      lookup: vi.fn(async () => lookupResult()),
    };
    const insight = await useCaseOf(lookup).execute({
      address: '0x1d4b7B0F0Bdd7Aa1C1a1c7C86Bc6a3d3F7B6E4A2',
    });

    expect(insight.found).toBe(true);
    expect(insight.quote).toBeUndefined();
  });

  it('rejects an empty query', async () => {
    const lookup: EnsLookupPort = { lookup: vi.fn() };
    await expect(useCaseOf(lookup).execute({})).rejects.toBeInstanceOf(
      DomainError,
    );
    expect(lookup.lookup).not.toHaveBeenCalled();
  });
});
