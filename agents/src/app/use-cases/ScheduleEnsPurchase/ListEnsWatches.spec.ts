import { describe, expect, it, vi } from 'vitest';
import { ListEnsWatches } from './ListEnsWatches.js';
import { InMemoryEnsWatchScheduler } from '../../../infrastructure/adapters/watch/InMemoryEnsWatchScheduler.js';
import type { EnsWatchSchedulerPort } from '../../ports/watch/EnsWatchSchedulerPort.js';
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

describe('ListEnsWatches', () => {
  it('refuses a chat outside the allowlist', async () => {
    const useCase = new ListEnsWatches(
      new InMemoryEnsWatchScheduler(),
      new Set([CHAT_ID]),
    );

    await expect(useCase.execute({ chatId: '99' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED_CHAT',
    });
  });

  it('only returns the watches armed by the requesting chat', async () => {
    const scheduler = new InMemoryEnsWatchScheduler();
    await scheduler.start(watchOf());
    await scheduler.start(
      watchOf({ label: 'other', name: 'other.eth', requesterChatId: '7' }),
    );

    const watches = await new ListEnsWatches(
      scheduler,
      new Set([CHAT_ID, '7']),
    ).execute({ chatId: CHAT_ID });

    expect(watches.map((watch) => watch.name)).toEqual(['deficat.eth']);
  });

  it('hides finished watches unless asked for them', async () => {
    const scheduler = new InMemoryEnsWatchScheduler();
    await scheduler.start(watchOf());
    scheduler.setStatus('ens-drop:deficat', 'bought');
    const useCase = new ListEnsWatches(scheduler, new Set([CHAT_ID]));

    expect(await useCase.execute({ chatId: CHAT_ID })).toEqual([]);
    expect(
      await useCase.execute({ chatId: CHAT_ID, includeFinished: true }),
    ).toHaveLength(1);
  });

  it('pushes the chat filter down to the port', async () => {
    const scheduler: EnsWatchSchedulerPort = {
      start: vi.fn(),
      cancel: vi.fn(),
      describe: vi.fn(),
      list: vi.fn(async () => []),
    };

    await new ListEnsWatches(scheduler, new Set([CHAT_ID])).execute({
      chatId: CHAT_ID,
    });

    expect(scheduler.list).toHaveBeenCalledWith({ requesterChatId: CHAT_ID });
  });

  it('reports an unreachable scheduler as retryable', async () => {
    const scheduler: EnsWatchSchedulerPort = {
      start: vi.fn(),
      cancel: vi.fn(),
      describe: vi.fn(),
      list: vi.fn(async () => {
        throw new Error('down');
      }),
    };

    await expect(
      new ListEnsWatches(scheduler, new Set([CHAT_ID])).execute({
        chatId: CHAT_ID,
      }),
    ).rejects.toMatchObject({
      code: 'SCHEDULER_UNAVAILABLE',
      retryable: true,
    });
  });
});
