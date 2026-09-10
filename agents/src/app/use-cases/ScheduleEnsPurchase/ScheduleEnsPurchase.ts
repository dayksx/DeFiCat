import { EnsLookupError, type EnsLookupPort } from '../../ports/graph/EnsLookupPort.js';
import {
  EnsWatchSchedulerError,
  type EnsWatchSchedulerPort,
} from '../../ports/watch/EnsWatchSchedulerPort.js';
import type { EnsDropWatch } from '../../../domain/ens/EnsDropWatch.js';
import {
  PurchaseEnsName,
  type EnsPurchaseQuote,
} from '../PurchaseEnsName/PurchaseEnsName.js';
import { EnsWatchError } from './EnsWatchError.js';

export type ScheduleEnsPurchaseRequest = {
  label: string;
  years: number;
  chatId: string;
};

export type ScheduleEnsPurchaseResult =
  /** The name is already purchasable: the caller should buy now rather than wait. */
  | { kind: 'buy-now'; quote: EnsPurchaseQuote }
  | { kind: 'scheduled'; workflowId: string; watch: EnsDropWatch; quote: EnsPurchaseQuote };

/**
 * Arms a watch that buys an ENS name the moment it drops and its price falls
 * within budget. Knows nothing about Temporal: the wait lives behind
 * `EnsWatchSchedulerPort`.
 */
export class ScheduleEnsPurchase {
  constructor(
    private readonly purchase: PurchaseEnsName,
    private readonly lookup: EnsLookupPort,
    private readonly scheduler: EnsWatchSchedulerPort,
    private readonly allowedChatIds: ReadonlySet<string>,
  ) {}

  async execute(
    request: ScheduleEnsPurchaseRequest,
  ): Promise<ScheduleEnsPurchaseResult> {
    this.assertAuthorized(request.chatId);

    const valid = this.purchase.validate(request);
    const quote = await this.purchase.quote(valid);

    if (quote.available && quote.withinBudget) {
      return { kind: 'buy-now', quote };
    }

    const watch: EnsDropWatch = {
      label: valid.label,
      name: valid.name,
      years: valid.years,
      durationSeconds: valid.durationSeconds,
      requesterChatId: request.chatId,
      maxWei: quote.maxBudgetWei,
      gracePeriodEndUnix: await this.readDropUnix(valid.name),
    };

    return {
      kind: 'scheduled',
      workflowId: (await this.start(watch)).workflowId,
      watch,
      quote,
    };
  }

  private assertAuthorized(chatId: string): void {
    if (!this.allowedChatIds.has(chatId)) {
      throw new EnsWatchError(
        'UNAUTHORIZED_CHAT',
        'This Telegram chat is not authorized to spend agent funds',
      );
    }
  }

  /**
   * Snapshot of when the name is released. The workflow re-reads it before
   * committing, so a renewal by the current owner cancels the watch instead of
   * buying a name that never dropped.
   */
  private async readDropUnix(name: string): Promise<number> {
    let gracePeriodEndDate: string | null;
    try {
      const result = await this.lookup.lookup({ kind: 'name', name });
      gracePeriodEndDate = result.domains[0]?.gracePeriodEndDate ?? null;
    } catch (error) {
      throw new EnsWatchError(
        'LOOKUP_UNAVAILABLE',
        error instanceof EnsLookupError
          ? 'ENS records are unreachable right now, so the drop date is unknown'
          : 'Could not read the ENS drop date',
        { retryable: true, cause: error },
      );
    }

    const unix =
      gracePeriodEndDate === null
        ? Number.NaN
        : Math.floor(Date.parse(gracePeriodEndDate) / 1000);

    if (!Number.isFinite(unix)) {
      throw new EnsWatchError(
        'DROP_DATE_UNKNOWN',
        `${name} has no known release date, so a watch cannot be armed`,
      );
    }

    return unix;
  }

  private async start(watch: EnsDropWatch): Promise<{ workflowId: string }> {
    try {
      return await this.scheduler.start(watch);
    } catch (error) {
      if (error instanceof EnsWatchSchedulerError) {
        if (error.failure === 'ALREADY_STARTED') {
          throw new EnsWatchError(
            'ALREADY_WATCHED',
            `${watch.name} is already being watched`,
            { cause: error },
          );
        }
        throw new EnsWatchError(
          'SCHEDULER_UNAVAILABLE',
          'The scheduler is unreachable right now, so no watch was armed',
          { retryable: true, cause: error },
        );
      }
      throw new EnsWatchError(
        'SCHEDULER_UNAVAILABLE',
        'The scheduler failed unexpectedly, so no watch was armed',
        { retryable: true, cause: error },
      );
    }
  }
}
