import {
  EnsWatchSchedulerError,
  workflowIdFor,
  type EnsWatchFilter,
  type EnsWatchView,
  type EnsWatchSchedulerPort,
} from '../../../app/ports/watch/EnsWatchSchedulerPort.js';
import {
  isActiveWatchStatus,
  type EnsDropWatch,
  type EnsDropWatchStatus,
} from '../../../domain/ens/EnsDropWatch.js';

/**
 * Records watches in memory and never buys anything. It exists so the use cases
 * and the LLM tools can be exercised without a Temporal server: every watch is
 * lost on restart, which is precisely the problem the Temporal adapter solves.
 * Never wire this in production.
 */
export class InMemoryEnsWatchScheduler implements EnsWatchSchedulerPort {
  private readonly views = new Map<string, EnsWatchView>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async start(watch: EnsDropWatch): Promise<{ workflowId: string }> {
    const workflowId = workflowIdFor(watch.label);
    const existing = this.views.get(workflowId);

    if (existing !== undefined && isActiveWatchStatus(existing.status)) {
      throw new EnsWatchSchedulerError(
        'ALREADY_STARTED',
        `A watch on ${watch.name} is already running`,
      );
    }

    this.views.set(workflowId, {
      ...watch,
      workflowId,
      status: 'scheduled',
      armedAt: this.now().toISOString(),
    });
    return { workflowId };
  }

  async cancel(workflowId: string): Promise<void> {
    this.setStatus(workflowId, 'cancelled');
  }

  async describe(workflowId: string): Promise<EnsWatchView> {
    return this.read(workflowId);
  }

  async list(filter: EnsWatchFilter = {}): Promise<EnsWatchView[]> {
    return [...this.views.values()]
      .filter(
        (view) =>
          filter.requesterChatId === undefined ||
          view.requesterChatId === filter.requesterChatId,
      )
      .sort((a, b) => b.armedAt.localeCompare(a.armedAt));
  }

  /** Test seam: move a watch forward without a Temporal server. */
  setStatus(workflowId: string, status: EnsDropWatchStatus): void {
    this.views.set(workflowId, { ...this.read(workflowId), status });
  }

  private read(workflowId: string): EnsWatchView {
    const view = this.views.get(workflowId);
    if (view === undefined) {
      throw new EnsWatchSchedulerError(
        'NOT_FOUND',
        `No watch known as ${workflowId}`,
      );
    }
    return view;
  }
}
