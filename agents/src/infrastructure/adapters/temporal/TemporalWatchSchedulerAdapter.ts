import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  type Client,
  type WorkflowExecutionInfo,
  type WorkflowHandle,
} from '@temporalio/client';
import {
  EnsWatchSchedulerError,
  workflowIdFor,
  type EnsWatchFilter,
  type EnsWatchSchedulerPort,
  type EnsWatchView,
} from '../../../app/ports/watch/EnsWatchSchedulerPort.js';
import type {
  EnsDropWatch,
  EnsDropWatchStatus,
} from '../../../domain/ens/EnsDropWatch.js';
import {
  cancelWatchSignal,
  watchEnsDrop,
  watchPhaseQuery,
} from './workflows/watchEnsDrop.workflow.js';

const WORKFLOW_TYPE = 'watchEnsDrop';

type Handle = WorkflowHandle<typeof watchEnsDrop>;

/**
 * Le strict nécessaire d'une exécution. `list` rend des `WorkflowExecutionInfo`
 * et `describe` des `WorkflowExecutionDescription`, qui divergent sur leur
 * champ `raw` : ce sous-ensemble laisse un seul mapping servir les deux.
 */
type ExecutionFacts = Pick<
  WorkflowExecutionInfo,
  'workflowId' | 'runId' | 'status' | 'startTime' | 'memo'
>;

/**
 * Traduit le port en workflows Temporal. Ne fait que démarrer, signaler et
 * lire : l'achat lui-même vit dans le processus worker.
 *
 * Temporal est la seule source de vérité, donc il n'y a pas de base à garder
 * synchronisée. Les faits immuables du watch voyagent dans le `memo`, qui reste
 * lisible sur une exécution terminée — contrairement à une query.
 */
export class TemporalWatchSchedulerAdapter implements EnsWatchSchedulerPort {
  constructor(
    private readonly client: Client,
    private readonly taskQueue: string,
  ) {}

  async start(watch: EnsDropWatch): Promise<{ workflowId: string }> {
    const workflowId = workflowIdFor(watch.label);

    try {
      await this.client.workflow.start(watchEnsDrop, {
        workflowId,
        taskQueue: this.taskQueue,
        args: [watch],
        memo: { ...watch },
        // L'id dérive du label, donc deux demandes sur le même nom se
        // télescopent. Le serveur refuse la seconde, ce qui rend l'armement
        // idempotent sans état de notre côté.
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
      });
      return { workflowId };
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        throw new EnsWatchSchedulerError(
          'ALREADY_STARTED',
          `A watch on ${watch.name} is already running`,
          { cause: error },
        );
      }
      throw new EnsWatchSchedulerError(
        'UNAVAILABLE',
        'Temporal refused to start the watch',
        { cause: error },
      );
    }
  }

  async cancel(workflowId: string): Promise<void> {
    try {
      // Un signal, pas `handle.cancel()` : le workflow prévient le demandeur
      // avant de s'arrêter, au lieu d'être coupé net pendant son sommeil.
      await this.client.workflow
        .getHandle(workflowId)
        .signal(cancelWatchSignal);
    } catch (error) {
      throw this.translate(error, workflowId);
    }
  }

  async describe(workflowId: string): Promise<EnsWatchView> {
    try {
      const description = await this.client.workflow
        .getHandle(workflowId)
        .describe();
      const view = await this.viewOf(description);
      if (view === null) {
        throw new EnsWatchSchedulerError(
          'NOT_FOUND',
          `${workflowId} carries no watch details`,
        );
      }
      return view;
    } catch (error) {
      if (error instanceof EnsWatchSchedulerError) throw error;
      throw this.translate(error, workflowId);
    }
  }

  async list(filter: EnsWatchFilter = {}): Promise<EnsWatchView[]> {
    const views: EnsWatchView[] = [];

    try {
      // Le filtrage par chat se fait sur le memo, côté client. Le faire côté
      // serveur demanderait un search attribute déclaré sur le namespace, donc
      // une étape d'infra qui casse `start` si elle est oubliée.
      for await (const info of this.client.workflow.list({
        query: `WorkflowType = '${WORKFLOW_TYPE}'`,
      })) {
        const view = await this.viewOf(info);
        if (view === null) continue;
        if (
          filter.requesterChatId !== undefined &&
          view.requesterChatId !== filter.requesterChatId
        ) {
          continue;
        }
        views.push(view);
      }
    } catch (error) {
      throw new EnsWatchSchedulerError(
        'UNAVAILABLE',
        'Temporal is unreachable right now',
        { cause: error },
      );
    }

    return views.sort((a, b) => b.armedAt.localeCompare(a.armedAt));
  }

  private async viewOf(info: ExecutionFacts): Promise<EnsWatchView | null> {
    const watch = watchFromMemo(info.memo);
    if (watch === null) return null;

    return {
      ...watch,
      workflowId: info.workflowId,
      status: await this.statusOf(info),
      armedAt: info.startTime.toISOString(),
    };
  }

  private async statusOf(info: ExecutionFacts): Promise<EnsDropWatchStatus> {
    const handle = this.client.workflow.getHandle<typeof watchEnsDrop>(
      info.workflowId,
      info.runId,
    );

    if (info.status.name === 'RUNNING' || info.status.name === 'PAUSED') {
      try {
        return await handle.query(watchPhaseQuery);
      } catch {
        // Un worker absent ne répond pas aux queries. Le watch existe quand
        // même, on le montre au stade le plus prudent.
        return 'scheduled';
      }
    }

    return this.closedStatus(handle);
  }

  /**
   * Une query ne répond que sur une exécution vivante, donc le statut final se
   * lit dans le résultat du workflow : `bought` ou `expired` s'il a rendu la
   * main, sinon on distingue une annulation d'un échec.
   */
  private async closedStatus(handle: Handle): Promise<EnsDropWatchStatus> {
    try {
      return await handle.result();
    } catch (error) {
      return isCancellation(error) ? 'cancelled' : 'failed';
    }
  }

  private translate(
    error: unknown,
    workflowId: string,
  ): EnsWatchSchedulerError {
    if (error instanceof WorkflowNotFoundError) {
      return new EnsWatchSchedulerError(
        'NOT_FOUND',
        `No watch known as ${workflowId}`,
        { cause: error },
      );
    }
    return new EnsWatchSchedulerError(
      'UNAVAILABLE',
      'Temporal is unreachable right now',
      { cause: error },
    );
  }
}

function isCancellation(error: unknown): boolean {
  let current: unknown = error;

  while (current instanceof Error) {
    if (
      current.name === 'CancelledFailure' ||
      current.name === 'TerminatedFailure' ||
      ('type' in current && current.type === 'CANCELLED')
    ) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

/**
 * Le memo traverse un convertisseur de payloads, donc rien ne garantit sa forme
 * au retour : une exécution démarrée par une version antérieure du code peut
 * très bien ne pas l'avoir. On la saute plutôt que de rendre une vue bancale.
 */
function watchFromMemo(memo: Record<string, unknown> | undefined): EnsDropWatch | null {
  if (memo === undefined) return null;

  const { label, name, years, durationSeconds, requesterChatId, maxWei, gracePeriodEndUnix } =
    memo;

  if (
    typeof label !== 'string' ||
    typeof name !== 'string' ||
    typeof years !== 'number' ||
    typeof durationSeconds !== 'number' ||
    typeof requesterChatId !== 'string' ||
    typeof maxWei !== 'string' ||
    typeof gracePeriodEndUnix !== 'number'
  ) {
    return null;
  }

  return {
    label,
    name,
    years,
    durationSeconds,
    requesterChatId,
    maxWei,
    gracePeriodEndUnix,
  };
}
