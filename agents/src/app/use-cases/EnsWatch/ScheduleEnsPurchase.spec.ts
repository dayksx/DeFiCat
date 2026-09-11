import { describe, expect, it, vi } from 'vitest';
import { ScheduleEnsPurchase } from './ScheduleEnsPurchase.js';
import { EnsWatchError } from './EnsWatchError.js';
import { PurchaseEnsName } from '../PurchaseEnsName/PurchaseEnsName.js';
import { EnsPurchaseError } from '../PurchaseEnsName/EnsPurchaseError.js';
import { EnsPurchasePolicy } from '../../../domain/ens/EnsPurchasePolicy.js';
import {
  EnsLookupError,
  type EnsLookupPort,
  type EnsLookupResult,
} from '../../ports/graph/EnsLookupPort.js';
import {
  EnsWatchSchedulerError,
  type EnsWatchSchedulerPort,
} from '../../ports/watch/EnsWatchSchedulerPort.js';
import type {
  EnsRegistrarPort,
  EnsRegistrationQuote,
  EnsRegistrationReceipt,
} from '../../ports/ens/EnsRegistrarPort.js';

const YEAR_SECONDS = 365 * 24 * 60 * 60;
const CHAT_ID = '42';
const GRACE_END_ISO = '2026-09-11T01:52:19.000Z';
const GRACE_END_UNIX = 1789091539;

function quoteOf(
  overrides: Partial<EnsRegistrationQuote> = {},
): EnsRegistrationQuote {
  return {
    name: 'deficat.eth',
    owner: '0x0000000000000000000000000000000000000001',
    available: false,
    durationSeconds: YEAR_SECONDS,
    baseWei: '100',
    premiumWei: '0',
    totalWei: '100',
    valueWithSlippageWei: '105',
    ...overrides,
  };
}

function registrarOf(quote: EnsRegistrationQuote): EnsRegistrarPort {
  return {
    quote: vi.fn(async () => quote),
    buy: vi.fn(async (): Promise<EnsRegistrationReceipt> => {
      throw new Error('ScheduleEnsPurchase must never buy directly');
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

function lookupOf(gracePeriodEndDate: string | null): EnsLookupPort {
  return {
    lookup: vi.fn(
      async (): Promise<EnsLookupResult> => ({
        domains: [
          {
            name: 'deficat.eth',
            labelName: 'deficat',
            labelhash: null,
            owner: '0x0000000000000000000000000000000000000001',
            registrant: null,
            wrappedOwner: null,
            resolvedAddress: null,
            createdAt: null,
            expiryDate: '2026-06-13T01:52:19.000Z',
            gracePeriodEndDate,
          },
        ],
        transfers: [],
      }),
    ),
  };
}

function schedulerOf(
  overrides: Partial<EnsWatchSchedulerPort> = {},
): EnsWatchSchedulerPort {
  return {
    start: vi.fn(async () => ({ workflowId: 'ens-drop:deficat' })),
    cancel: vi.fn(async () => undefined),
    describe: vi.fn(),
    list: vi.fn(async () => []),
    ...overrides,
  };
}

function useCaseOf(opts: {
  quote?: EnsRegistrationQuote;
  gracePeriodEndDate?: string | null;
  lookup?: EnsLookupPort;
  scheduler?: EnsWatchSchedulerPort;
  maxPurchaseWei?: string;
  allowedChatIds?: ReadonlySet<string>;
} = {}) {
  const scheduler = opts.scheduler ?? schedulerOf();
  const lookup =
    opts.lookup ??
    lookupOf(
      opts.gracePeriodEndDate === undefined
        ? GRACE_END_ISO
        : opts.gracePeriodEndDate,
    );
  const purchase = new PurchaseEnsName(
    registrarOf(opts.quote ?? quoteOf()),
    new EnsPurchasePolicy(),
    opts.maxPurchaseWei ?? '1000',
  );

  return {
    scheduler,
    lookup,
    useCase: new ScheduleEnsPurchase(
      purchase,
      lookup,
      scheduler,
      opts.allowedChatIds ?? new Set([CHAT_ID]),
    ),
  };
}

describe('ScheduleEnsPurchase', () => {
  it('refuses a chat outside the allowlist before touching the network', async () => {
    const { useCase, scheduler, lookup } = useCaseOf();

    await expect(
      useCase.execute({ label: 'deficat', years: 1, chatId: '99' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED_CHAT' });

    expect(scheduler.start).not.toHaveBeenCalled();
    expect(lookup.lookup).not.toHaveBeenCalled();
  });

  it('tells the caller to buy now instead of arming a watch', async () => {
    const { useCase, scheduler } = useCaseOf({
      quote: quoteOf({ available: true }),
    });

    const result = await useCase.execute({
      label: 'deficat',
      years: 1,
      chatId: CHAT_ID,
    });

    expect(result).toMatchObject({ kind: 'buy-now' });
    expect(scheduler.start).not.toHaveBeenCalled();
  });

  it('arms a watch on a registered name, snapshotting the drop date', async () => {
    const { useCase, scheduler } = useCaseOf();

    const result = await useCase.execute({
      label: '  DefiCat.eth ',
      years: 2,
      chatId: CHAT_ID,
    });

    expect(result).toEqual({
      kind: 'scheduled',
      workflowId: 'ens-drop:deficat',
      watch: {
        label: 'deficat',
        name: 'deficat.eth',
        years: 2,
        durationSeconds: 2 * YEAR_SECONDS,
        requesterChatId: CHAT_ID,
        maxWei: '1000',
        gracePeriodEndUnix: GRACE_END_UNIX,
      },
      quote: expect.objectContaining({ available: false }),
    });
    expect(scheduler.start).toHaveBeenCalledTimes(1);
  });

  it('arms a watch when the name is free but still above budget', async () => {
    const { useCase, scheduler } = useCaseOf({
      quote: quoteOf({ available: true, valueWithSlippageWei: '5000' }),
    });

    const result = await useCase.execute({
      label: 'deficat',
      years: 1,
      chatId: CHAT_ID,
    });

    expect(result).toMatchObject({ kind: 'scheduled' });
    expect(scheduler.start).toHaveBeenCalledTimes(1);
  });

  it('refuses to arm a watch when no release date is known', async () => {
    const { useCase, scheduler } = useCaseOf({ gracePeriodEndDate: null });

    await expect(
      useCase.execute({ label: 'deficat', years: 1, chatId: CHAT_ID }),
    ).rejects.toMatchObject({ code: 'DROP_DATE_UNKNOWN' });

    expect(scheduler.start).not.toHaveBeenCalled();
  });

  it('reports an unreachable lookup as retryable', async () => {
    const { useCase } = useCaseOf({
      lookup: { lookup: vi.fn(async () => { throw new EnsLookupError('down'); }) },
    });

    await expect(
      useCase.execute({ label: 'deficat', years: 1, chatId: CHAT_ID }),
    ).rejects.toMatchObject({ code: 'LOOKUP_UNAVAILABLE', retryable: true });
  });

  it('translates a duplicate workflow into ALREADY_WATCHED', async () => {
    const { useCase } = useCaseOf({
      scheduler: schedulerOf({
        start: vi.fn(async () => {
          throw new EnsWatchSchedulerError('ALREADY_STARTED', 'duplicate');
        }),
      }),
    });

    const error = await useCase
      .execute({ label: 'deficat', years: 1, chatId: CHAT_ID })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EnsWatchError);
    expect(error).toMatchObject({
      code: 'ALREADY_WATCHED',
      retryable: false,
    });
  });

  it('rejects an invalid label through the shared purchase policy', async () => {
    const { useCase, lookup } = useCaseOf();

    const error = await useCase
      .execute({ label: 'a.b', years: 1, chatId: CHAT_ID })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EnsPurchaseError);
    expect(error).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(lookup.lookup).not.toHaveBeenCalled();
  });
});
