import { describe, expect, it, vi } from 'vitest';
import { CancelEnsWatch } from './CancelEnsWatch.js';
import { EnsPurchasePolicy } from '../../../domain/ens/EnsPurchasePolicy.js';
import {
  EnsWatchSchedulerError,
  type EnsWatchSchedulerPort,
} from '../../ports/watch/EnsWatchSchedulerPort.js';
import { InMemoryEnsWatchScheduler } from '../../../infrastructure/adapters/watch/InMemoryEnsWatchScheduler.js';
import type { EnsDropWatch } from '../../../domain/ens/EnsDropWatch.js';

const CHAT_ID = '42';

function watchOf(overrides: Partial<EnsDropWatch> = {}): EnsDropWatch {
  return {
    label: 'deficat',
    name: 'deficat.eth',
    years: 1,
    durationSeconds: 365 * 24 * 60 * 60,
    requesterChatId: CHAT_ID,
    maxWei: '1000',
    gracePeriodEndUnix: 1789091539,
    ...overrides,
  };
}

function useCaseOf(
  scheduler: EnsWatchSchedulerPort,
  allowedChatIds: ReadonlySet<string> = new Set([CHAT_ID]),
) {
  return new CancelEnsWatch(
    new EnsPurchasePolicy(),
    scheduler,
    allowedChatIds,
  );
}

describe('CancelEnsWatch', () => {
  it('refuses a chat outside the allowlist', async () => {
    const scheduler = new InMemoryEnsWatchScheduler();
    await scheduler.start(watchOf());

    await expect(
      useCaseOf(scheduler).execute({ label: 'deficat', chatId: '99' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED_CHAT' });

    expect((await scheduler.describe('ens-drop:deficat')).status).toBe(
      'scheduled',
    );
  });

  it('cancels the watch armed by the requesting chat', async () => {
    const scheduler = new InMemoryEnsWatchScheduler();
    await scheduler.start(watchOf());

    const result = await useCaseOf(scheduler).execute({
      label: 'DefiCat.eth',
      chatId: CHAT_ID,
    });

    expect(result).toEqual({
      workflowId: 'ens-drop:deficat',
      name: 'deficat.eth',
    });
    expect(await scheduler.describe('ens-drop:deficat')).toMatchObject({
      status: 'cancelled',
    });
  });

  it('refuses to cancel a watch armed from another chat', async () => {
    const scheduler = new InMemoryEnsWatchScheduler();
    await scheduler.start(watchOf({ requesterChatId: '7' }));

    await expect(
      useCaseOf(scheduler, new Set([CHAT_ID, '7'])).execute({
        label: 'deficat',
        chatId: CHAT_ID,
      }),
    ).rejects.toMatchObject({ code: 'NOT_WATCH_OWNER' });

    expect((await scheduler.describe('ens-drop:deficat')).status).toBe(
      'scheduled',
    );
  });

  it('reports a watch that was never armed', async () => {
    await expect(
      useCaseOf(new InMemoryEnsWatchScheduler()).execute({
        label: 'deficat',
        chatId: CHAT_ID,
      }),
    ).rejects.toMatchObject({ code: 'WATCH_NOT_FOUND' });
  });

  it('reports a watch that already finished', async () => {
    const scheduler = new InMemoryEnsWatchScheduler();
    await scheduler.start(watchOf());
    await scheduler.cancel('ens-drop:deficat');

    await expect(
      useCaseOf(scheduler).execute({ label: 'deficat', chatId: CHAT_ID }),
    ).rejects.toMatchObject({ code: 'WATCH_NOT_ACTIVE' });
  });

  it('rejects an invalid label without calling the scheduler', async () => {
    const scheduler: EnsWatchSchedulerPort = {
      start: vi.fn(),
      cancel: vi.fn(),
      describe: vi.fn(),
      list: vi.fn(),
    };

    await expect(
      useCaseOf(scheduler).execute({ label: 'a.b', chatId: CHAT_ID }),
    ).rejects.toMatchObject({ code: 'WATCH_NOT_FOUND' });

    expect(scheduler.describe).not.toHaveBeenCalled();
  });

  it('surfaces an unreachable scheduler as retryable', async () => {
    const scheduler: EnsWatchSchedulerPort = {
      start: vi.fn(),
      cancel: vi.fn(),
      list: vi.fn(),
      describe: vi.fn(async () => {
        throw new EnsWatchSchedulerError('UNAVAILABLE', 'down');
      }),
    };

    await expect(
      useCaseOf(scheduler).execute({ label: 'deficat', chatId: CHAT_ID }),
    ).rejects.toMatchObject({
      code: 'SCHEDULER_UNAVAILABLE',
      retryable: true,
    });
  });
});
