import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EnsDropWatch } from '../../../../domain/ens/EnsDropWatch.js';
import type {
  CommitNameInput,
  EnsDropActivities,
  QuoteView,
} from '../activities/ensDrop.activities.js';
import { cancelWatchSignal, watchEnsDrop } from './watchEnsDrop.workflow.js';

/**
 * Le seul endroit où la branche qui dépense de l'argent s'exécute avant la
 * production. En vrai le workflow dort des mois puis signe deux transactions à
 * soixante secondes d'intervalle ; ici l'horloge du serveur de test saute ces
 * attentes, donc le chemin complet tient en quelques millisecondes.
 *
 * Le worker bundle le workflow depuis la source TypeScript, exactement comme le
 * vrai le fait depuis `dist-worker`.
 */
const WORKFLOW_PATH = fileURLToPath(
  new URL('./watchEnsDrop.workflow.ts', import.meta.url),
);

/** 0,02 ETH, le plafond que porte le watch. */
const MAX_WEI = '20000000000000000';
/** Prix hors premium : le plancher que la décote ne fera jamais descendre. */
const FLOOR_WEI = 5_000_000_000_000_000n;
/** Un premium qui met le nom largement hors budget. */
const STEEP_PREMIUM = 10n ** 18n;

const DAY_SECONDS = 24 * 60 * 60;

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
  await env?.teardown();
});

function watchOf(overrides: Partial<EnsDropWatch> = {}): EnsDropWatch {
  return {
    label: 'deficat',
    name: 'deficat.eth',
    years: 1,
    durationSeconds: 365 * DAY_SECONDS,
    requesterChatId: '42',
    maxWei: MAX_WEI,
    // Dans six mois : le workflow part donc par son sommeil durable.
    gracePeriodEndUnix: Math.floor(Date.now() / 1000) + 180 * DAY_SECONDS,
    ...overrides,
  };
}

/**
 * Une cotation cohérente avec le watch. Reprendre sa date de libération est
 * obligatoire : le workflow lit toute date plus lointaine comme un
 * renouvellement du titulaire et abandonne.
 */
function quoteFor(watch: EnsDropWatch, premiumWei: bigint): QuoteView {
  const totalWei = FLOOR_WEI + premiumWei;

  return {
    available: true,
    withinBudget: totalWei <= BigInt(watch.maxWei),
    totalWei: totalWei.toString(),
    premiumWei: premiumWei.toString(),
    gracePeriodEndUnix: watch.gracePeriodEndUnix,
  };
}

/** Rend la suite de premiums d'affilée, puis répète la dernière valeur. */
function quotesDecaying(watch: EnsDropWatch, premiums: readonly bigint[]) {
  let call = 0;

  return async (): Promise<QuoteView> => {
    const premium = premiums[Math.min(call, premiums.length - 1)];
    call += 1;
    return quoteFor(watch, premium as bigint);
  };
}

const commitOk = async (input: CommitNameInput) => ({
  secret: input.secret,
  commitmentTransactionHash: '0xcommit',
});

const registerOk = async () => ({
  registrationTransactionHash: '0xregister',
  totalPaidWei: FLOOR_WEI.toString(),
});

/** Le type d'`ApplicationFailure` qui a clos le workflow, s'il a échoué. */
async function failureTypeOf(result: Promise<unknown>): Promise<string | null> {
  try {
    await result;
    return null;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof ApplicationFailure ? (cause.type ?? null) : null;
  }
}

/** Un worker jetable sur sa propre file, pour que les tests ne se croisent pas. */
async function onWorker<T>(
  activities: EnsDropActivities,
  body: (taskQueue: string) => Promise<T>,
): Promise<T> {
  const taskQueue = `watch-${randomUUID()}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: WORKFLOW_PATH,
    activities,
  });

  return worker.runUntil(body(taskQueue));
}

describe('watchEnsDrop', () => {
  it('buys the name once the price comes within budget', async () => {
    const watch = watchOf();
    // Deux cotations hors budget, puis le premium tombe. La quatrième est la
    // re-vérification d'après commitment.
    const refreshQuote = vi.fn(
      quotesDecaying(watch, [STEEP_PREMIUM, STEEP_PREMIUM / 4n, 0n, 0n]),
    );
    const commitName = vi.fn(commitOk);
    const registerName = vi.fn(registerOk);
    const notifyChat = vi.fn(async () => {});

    const status = await onWorker(
      { refreshQuote, commitName, registerName, notifyChat },
      (taskQueue) =>
        env.client.workflow.execute(watchEnsDrop, {
          workflowId: `watch-${randomUUID()}`,
          taskQueue,
          args: [watch],
        }),
    );

    expect(status).toBe('bought');
    expect(commitName).toHaveBeenCalledTimes(1);
    expect(registerName).toHaveBeenCalledTimes(1);
    // La révélation doit porter le secret du commitment miné : un secret
    // régénéré révélerait un commitment qui n'existe pas, et brûlerait le gas
    // du commit pour rien.
    expect(registerName.mock.calls[0]?.[0].secret).toBe(
      commitName.mock.calls[0]?.[0].secret,
    );
    expect(notifyChat).toHaveBeenLastCalledWith({
      chatId: '42',
      message: expect.stringContaining('0xregister'),
    });
  });

  it('walks away after the commitment when the price leaves the budget', async () => {
    const watch = watchOf();
    // Dans le budget à l'armement, hors budget à la re-vérification : quelqu'un
    // a surenchéri pendant les soixante secondes du commitment.
    const refreshQuote = vi.fn(quotesDecaying(watch, [0n, STEEP_PREMIUM]));
    const commitName = vi.fn(commitOk);
    const registerName = vi.fn(registerOk);
    const notifyChat = vi.fn(async () => {});

    const failure = await onWorker(
      { refreshQuote, commitName, registerName, notifyChat },
      (taskQueue) =>
        failureTypeOf(
          env.client.workflow.execute(watchEnsDrop, {
            workflowId: `watch-${randomUUID()}`,
            taskQueue,
            args: [watch],
          }),
        ),
    );

    expect(failure).toBe('COMMITTED_NOT_REGISTERED');
    expect(commitName).toHaveBeenCalledTimes(1);
    expect(registerName).not.toHaveBeenCalled();
  });

  it('stops when the holder renews the name', async () => {
    const watch = watchOf();
    const refreshQuote = vi.fn(async () => ({
      ...quoteFor(watch, 0n),
      // La libération recule d'un an : le watch n'a plus d'objet.
      gracePeriodEndUnix: watch.gracePeriodEndUnix + 365 * DAY_SECONDS,
    }));
    const commitName = vi.fn(commitOk);
    const registerName = vi.fn(registerOk);
    const notifyChat = vi.fn(async () => {});

    const status = await onWorker(
      { refreshQuote, commitName, registerName, notifyChat },
      (taskQueue) =>
        env.client.workflow.execute(watchEnsDrop, {
          workflowId: `watch-${randomUUID()}`,
          taskQueue,
          args: [watch],
        }),
    );

    expect(status).toBe('expired');
    expect(commitName).not.toHaveBeenCalled();
    expect(notifyChat).toHaveBeenCalledWith({
      chatId: '42',
      message: expect.stringContaining('renewed'),
    });
  });

  it('honours a cancellation received during the months-long sleep', async () => {
    const watch = watchOf();
    const refreshQuote = vi.fn(quotesDecaying(watch, [0n]));
    const commitName = vi.fn(commitOk);
    const registerName = vi.fn(registerOk);
    const notifyChat = vi.fn(async () => {});

    const failure = await onWorker(
      { refreshQuote, commitName, registerName, notifyChat },
      async (taskQueue) => {
        const handle = await env.client.workflow.start(watchEnsDrop, {
          workflowId: `watch-${randomUUID()}`,
          taskQueue,
          args: [watch],
        });
        await handle.signal(cancelWatchSignal);
        return failureTypeOf(handle.result());
      },
    );

    expect(failure).toBe('CANCELLED');
    // Annulé avant même le réveil : il n'a jamais coté, encore moins acheté.
    expect(refreshQuote).not.toHaveBeenCalled();
    expect(notifyChat).toHaveBeenCalledWith({
      chatId: '42',
      message: expect.stringContaining('Cancelled'),
    });
  });

  it('breaks out of the polling wait instead of sleeping it off', async () => {
    // Libération déjà passée : le workflow saute le sommeil durable et entre
    // directement dans la boucle, où l'attente peut durer des heures.
    const watch = watchOf({
      gracePeriodEndUnix: Math.floor(Date.now() / 1000) - 3600,
    });
    const refreshQuote = vi.fn(quotesDecaying(watch, [STEEP_PREMIUM]));
    const commitName = vi.fn(commitOk);
    const registerName = vi.fn(registerOk);
    const notifyChat = vi.fn(async () => {});

    const failure = await onWorker(
      { refreshQuote, commitName, registerName, notifyChat },
      async (taskQueue) => {
        const handle = await env.client.workflow.start(watchEnsDrop, {
          workflowId: `watch-${randomUUID()}`,
          taskQueue,
          args: [watch],
        });
        await handle.signal(cancelWatchSignal);
        return failureTypeOf(handle.result());
      },
    );

    expect(failure).toBe('CANCELLED');
    // Sans la course entre le sommeil et l'annulation, il aurait coté encore et
    // encore avant de s'arrêter.
    expect(refreshQuote.mock.calls.length).toBeLessThanOrEqual(2);
    expect(registerName).not.toHaveBeenCalled();
  });
});
