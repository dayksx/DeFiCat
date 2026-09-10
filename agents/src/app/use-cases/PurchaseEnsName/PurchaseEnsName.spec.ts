import { describe, expect, it, vi } from 'vitest';
import {
  EnsRegistrationError,
  type EnsRegistrarPort,
  type EnsRegistrationQuote,
  type EnsRegistrationReceipt,
} from '../../ports/ens/EnsRegistrarPort.js';
import { EnsPurchasePolicy } from '../../../domain/ens/EnsPurchasePolicy.js';
import { EnsPurchaseError } from './EnsPurchaseError.js';
import { PurchaseEnsName } from './PurchaseEnsName.js';

const YEAR_SECONDS = 365 * 24 * 60 * 60;

function quoteOf(overrides: Partial<EnsRegistrationQuote> = {}) {
  return {
    name: 'deficat.eth',
    owner: '0x0000000000000000000000000000000000000001',
    available: true,
    durationSeconds: YEAR_SECONDS,
    baseWei: '100',
    premiumWei: '0',
    totalWei: '100',
    valueWithSlippageWei: '105',
    ...overrides,
  } satisfies EnsRegistrationQuote;
}

function registrarOf(
  overrides: Partial<EnsRegistrarPort> = {},
): EnsRegistrarPort {
  return {
    quote: vi.fn(async () => quoteOf()),
    buy: vi.fn(async (): Promise<EnsRegistrationReceipt> => receiptOf()),
    // PurchaseEnsName only ever calls quote and buy; the rest exists so the
    // stub satisfies the port that scheduled purchases rely on.
    commit: vi.fn(async (input) => ({
      label: input.label,
      durationSeconds: input.durationSeconds,
      secret: `0x${'3'.repeat(64)}`,
      commitment: `0x${'4'.repeat(64)}`,
      commitmentTransactionHash: `0x${'1'.repeat(64)}`,
    })),
    register: vi.fn(async (): Promise<EnsRegistrationReceipt> => receiptOf()),
    minCommitmentAgeSeconds: vi.fn(async () => 60),
    ...overrides,
  };
}

function receiptOf(): EnsRegistrationReceipt {
  return {
    name: 'deficat.eth',
    owner: '0x0000000000000000000000000000000000000001',
    commitmentTransactionHash: `0x${'1'.repeat(64)}`,
    registrationTransactionHash: `0x${'2'.repeat(64)}`,
    totalPaidWei: '105',
  };
}

function useCaseOf(registrar: EnsRegistrarPort, maxPurchaseWei = '1000') {
  return new PurchaseEnsName(
    registrar,
    new EnsPurchasePolicy(),
    maxPurchaseWei,
  );
}

describe('PurchaseEnsName.quote', () => {
  it('reports an out-of-budget price instead of throwing', async () => {
    const quote = await useCaseOf(registrarOf(), '10').quote({
      label: 'deficat',
      years: 1,
    });

    expect(quote).toMatchObject({
      withinBudget: false,
      maxBudgetWei: '10',
      totalWei: '100',
      years: 1,
    });
  });

  it('reports an unavailable name instead of throwing', async () => {
    const registrar = registrarOf({
      quote: vi.fn(async () => quoteOf({ available: false })),
    });

    await expect(
      useCaseOf(registrar).quote({ label: 'deficat', years: 1 }),
    ).resolves.toMatchObject({ available: false, withinBudget: true });
  });

  it('rejects an invalid label with INVALID_REQUEST before any network call', async () => {
    const registrar = registrarOf();

    await expect(
      useCaseOf(registrar).quote({ label: 'sub.deficat.eth', years: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(registrar.quote).not.toHaveBeenCalled();
  });
});

describe('PurchaseEnsName.execute', () => {
  it('does not buy an unavailable name', async () => {
    const registrar = registrarOf({
      quote: vi.fn(async () => quoteOf({ available: false })),
    });

    await expect(
      useCaseOf(registrar).execute({ label: 'deficat', years: 1 }),
    ).rejects.toMatchObject({ code: 'NAME_UNAVAILABLE' });
    expect(registrar.buy).not.toHaveBeenCalled();
  });

  it('does not buy above the budget', async () => {
    const registrar = registrarOf();

    await expect(
      useCaseOf(registrar, '10').execute({ label: 'deficat', years: 1 }),
    ).rejects.toMatchObject({ code: 'OVER_BUDGET' });
    expect(registrar.buy).not.toHaveBeenCalled();
  });

  it('buys with the normalized label rather than a re-parsed name', async () => {
    const registrar = registrarOf();

    await useCaseOf(registrar).execute({ label: '  DefiCat.ETH ', years: 2 });

    expect(registrar.buy).toHaveBeenCalledWith({
      label: 'deficat',
      durationSeconds: 2 * YEAR_SECONDS,
      maxTotalCostWei: '1000',
    });
  });

  it('marks an unreachable node as retryable', async () => {
    const registrar = registrarOf({
      buy: vi.fn(async () => {
        throw new EnsRegistrationError(
          'CHAIN_UNAVAILABLE',
          'connect ETIMEDOUT 10.0.0.1:8545',
          {
            cause: new Error('socket hang up'),
          },
        );
      }),
    });

    await expect(
      useCaseOf(registrar).execute({ label: 'deficat', years: 1 }),
    ).rejects.toMatchObject({ code: 'CHAIN_UNAVAILABLE', retryable: true });
  });

  it('never leaks the raw infrastructure message', async () => {
    const registrar = registrarOf({
      buy: vi.fn(async () => {
        throw new EnsRegistrationError(
          'CHAIN_UNAVAILABLE',
          'HTTP request failed. URL: https://eth.example/v3/SECRET_KEY',
        );
      }),
    });

    const error = await useCaseOf(registrar)
      .execute({ label: 'deficat', years: 1 })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(EnsPurchaseError);
    expect((error as EnsPurchaseError).message).not.toContain('SECRET_KEY');
    expect((error as EnsPurchaseError).cause).toBeInstanceOf(
      EnsRegistrationError,
    );
  });

  it('surfaces the commitment hash when gas was spent without registering', async () => {
    const commitmentTransactionHash = `0x${'a'.repeat(64)}`;
    const registrar = registrarOf({
      buy: vi.fn(async () => {
        throw new EnsRegistrationError(
          'REGISTRATION_FAILED',
          'Commitment was mined but deficat.eth is not available',
          { commitmentTransactionHash },
        );
      }),
    });

    await expect(
      useCaseOf(registrar).execute({ label: 'deficat', years: 1 }),
    ).rejects.toMatchObject({
      code: 'COMMITTED_NOT_REGISTERED',
      retryable: false,
      commitmentTransactionHash,
    });
  });

  it('falls back to PURCHASE_FAILED for an unknown throw', async () => {
    const registrar = registrarOf({
      buy: vi.fn(async () => {
        throw new TypeError('cannot read properties of undefined');
      }),
    });

    await expect(
      useCaseOf(registrar).execute({ label: 'deficat', years: 1 }),
    ).rejects.toMatchObject({ code: 'PURCHASE_FAILED' });
  });
});
