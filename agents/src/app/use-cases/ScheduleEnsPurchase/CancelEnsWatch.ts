import {
  EnsWatchSchedulerError,
  workflowIdFor,
  type EnsWatchSchedulerPort,
} from '../../ports/watch/EnsWatchSchedulerPort.js';
import { EnsPurchasePolicy } from '../../../domain/ens/EnsPurchasePolicy.js';
import { isActiveWatchStatus } from '../../../domain/ens/EnsDropWatch.js';
import { DomainError } from '../../../domain/errors/DomainError.js';
import { EnsWatchError } from './EnsWatchError.js';

export type CancelEnsWatchRequest = {
  label: string;
  chatId: string;
};

export type CancelEnsWatchResult = {
  workflowId: string;
  name: string;
};

/** Stops a watch armed earlier, and only on behalf of the chat that armed it. */
export class CancelEnsWatch {
  constructor(
    private readonly policy: EnsPurchasePolicy,
    private readonly scheduler: EnsWatchSchedulerPort,
    private readonly allowedChatIds: ReadonlySet<string>,
  ) {}

  async execute(request: CancelEnsWatchRequest): Promise<CancelEnsWatchResult> {
    if (!this.allowedChatIds.has(request.chatId)) {
      throw new EnsWatchError(
        'UNAUTHORIZED_CHAT',
        'This Telegram chat is not authorized to manage agent watches',
      );
    }

    const { label, name } = this.normalize(request.label);
    const workflowId = workflowIdFor(label);
    const watch = await this.describe(workflowId, name);

    if (!isActiveWatchStatus(watch.status)) {
      throw new EnsWatchError(
        'WATCH_NOT_ACTIVE',
        `The watch on ${name} already finished with status ${watch.status}`,
      );
    }
    if (watch.requesterChatId !== request.chatId) {
      throw new EnsWatchError(
        'NOT_WATCH_OWNER',
        `The watch on ${name} was armed from another chat and can only be cancelled there`,
      );
    }

    try {
      await this.scheduler.cancel(workflowId);
    } catch (error) {
      throw new EnsWatchError(
        'SCHEDULER_UNAVAILABLE',
        `Could not cancel the watch on ${name}, so it may still be active`,
        { retryable: true, cause: error },
      );
    }

    return { workflowId, name };
  }

  private normalize(label: string): { label: string; name: string } {
    try {
      return this.policy.normalizeLabel(label);
    } catch (error) {
      throw new EnsWatchError(
        'WATCH_NOT_FOUND',
        error instanceof DomainError
          ? error.message
          : 'Invalid ENS label for a watch',
        { cause: error },
      );
    }
  }

  private async describe(workflowId: string, name: string) {
    try {
      return await this.scheduler.describe(workflowId);
    } catch (error) {
      if (
        error instanceof EnsWatchSchedulerError &&
        error.failure === 'NOT_FOUND'
      ) {
        throw new EnsWatchError(
          'WATCH_NOT_FOUND',
          `There is no watch on ${name}`,
          { cause: error },
        );
      }
      throw new EnsWatchError(
        'SCHEDULER_UNAVAILABLE',
        'The scheduler is unreachable right now, so the watch was left untouched',
        { retryable: true, cause: error },
      );
    }
  }
}
