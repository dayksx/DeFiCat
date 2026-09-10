import {
  ApplicationFailure,
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
  uuid4,
} from '@temporalio/workflow';
import type { EnsDropWatchStatus } from '../../../../domain/ens/EnsDropWatch.js';
import type { EnsDropActivities } from '../activities/ensDrop.activities.js';
import type { WatchEnsDropInput } from './watchEnsDrop.types.js';

export const cancelWatchSignal = defineSignal('cancelWatch');

/**
 * Phase courante. Le statut d'exécution Temporal ne distingue pas « dort encore
 * six mois » de « commitment miné, achat imminent », qui est exactement ce
 * qu'un utilisateur veut savoir.
 */
export const watchPhaseQuery = defineQuery<EnsDropWatchStatus>('watchPhase');

const quoteActs = proxyActivities<EnsDropActivities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 5,
    initialInterval: '2s',
    backoffCoefficient: 2,
    // Types portés par ApplicationFailure côté worker, depuis EnsPurchaseError.code.
    nonRetryableErrorTypes: [
      'INVALID_REQUEST',
      'OVER_BUDGET',
      'INSUFFICIENT_FUNDS',
      'NAME_UNAVAILABLE',
    ],
  },
});

const commitActs = proxyActivities<EnsDropActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3, initialInterval: '5s' },
});

const registerActs = proxyActivities<EnsDropActivities>({
  startToCloseTimeout: '3 minutes',
  retry: { maximumAttempts: 1 },
});

const notifyActs = proxyActivities<EnsDropActivities>({
  startToCloseTimeout: '20 seconds',
  retry: { maximumAttempts: 5 },
});

/** Marge de réveil avant la fin de grâce : on veut juste être là pour poller. */
const WAKE_UP_BEFORE_DROP_MS = 23 * 60 * 60 * 1000;
const POLL_MS = 30_000;

export async function watchEnsDrop(
  input: WatchEnsDropInput,
): Promise<EnsDropWatchStatus> {
  let cancelled = false;
  let phase: EnsDropWatchStatus = 'scheduled';

  setHandler(cancelWatchSignal, () => {
    cancelled = true;
  });
  setHandler(watchPhaseQuery, () => phase);

  const refresh = () =>
    quoteActs.refreshQuote({
      label: input.label,
      years: input.years,
      maxWei: input.maxWei,
    });

  const abortIfCancelled = async () => {
    if (!cancelled) return;
    await notifyActs.notifyChat({
      chatId: input.requesterChatId,
      message: `Cancelled watch on ${input.name}`,
    });
    throw ApplicationFailure.nonRetryable('Watch cancelled', 'CANCELLED');
  };

  /** Le titulaire a renouvelé : la libération recule, le watch n'a plus d'objet. */
  const renewed = async (gracePeriodEndUnix: number) => {
    if (gracePeriodEndUnix <= input.gracePeriodEndUnix) return false;
    await notifyActs.notifyChat({
      chatId: input.requesterChatId,
      message: `${input.name} was renewed. Watch expired.`,
    });
    return true;
  };

  // --- sommeil durable : se réveiller peu avant le drop, juste pour poller ---
  const armAtMs = input.gracePeriodEndUnix * 1000 - WAKE_UP_BEFORE_DROP_MS;
  const delay = armAtMs - Date.now(); // Date.now est patché par Temporal ici
  if (delay > 0) {
    await Promise.race([sleep(delay), condition(() => cancelled)]);
    await abortIfCancelled();
  }

  // --- arming : attendre que le nom soit libre et dans le budget ---
  phase = 'arming';
  let quote = await refresh();
  if (await renewed(quote.gracePeriodEndUnix)) return 'expired';

  while (!quote.available || !quote.withinBudget) {
    await abortIfCancelled();
    await sleep(POLL_MS);
    quote = await refresh();
    if (await renewed(quote.gracePeriodEndUnix)) return 'expired';
  }

  // Généré dans le workflow, donc identique à chaque replay : une activité
  // rejouée réutilise ce secret au lieu de miner un second commitment.
  const secret = `0x${`${uuid4()}${uuid4()}`.replace(/-/g, '')}`;

  const commitment = await commitActs.commitName({
    label: input.label,
    durationSeconds: input.durationSeconds,
    secret,
  });
  phase = 'committed';

  const minCommitmentAgeSeconds = 62;
  await sleep(minCommitmentAgeSeconds * 1000);

  // Dernière vérification avant de dépenser : entre le commit et maintenant, le
  // nom a pu être pris par quelqu'un d'autre ou repartir au-dessus du budget.
  quote = await refresh();
  if (!quote.available || !quote.withinBudget) {
    throw ApplicationFailure.nonRetryable(
      `${input.name} left budget or availability after the commitment was mined`,
      'COMMITTED_NOT_REGISTERED',
    );
  }

  phase = 'buying';
  const receipt = await registerActs.registerName({
    label: input.label,
    durationSeconds: input.durationSeconds,
    maxWei: input.maxWei,
    secret: commitment.secret,
    commitmentTransactionHash: commitment.commitmentTransactionHash,
  });
  phase = 'bought';

  await notifyActs.notifyChat({
    chatId: input.requesterChatId,
    message: `Purchased ${input.name} for ${receipt.totalPaidWei} wei, tx ${receipt.registrationTransactionHash}`,
  });

  return 'bought';
}
