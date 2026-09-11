import type {
  EnsWatchSchedulerPort,
  EnsWatchView,
} from '../../ports/watch/EnsWatchSchedulerPort.js';
import { isActiveWatchStatus } from '../../../domain/ens/EnsDropWatch.js';
import { EnsWatchError } from './EnsWatchError.js';

export type ListEnsWatchesRequest = {
  chatId: string;
  /** Par défaut, seuls les watchs encore capables de dépenser. */
  includeFinished?: boolean;
};

export class ListEnsWatches {
  constructor(
    private readonly scheduler: EnsWatchSchedulerPort,
    private readonly allowedChatIds: ReadonlySet<string>,
  ) {}

  async execute(request: ListEnsWatchesRequest): Promise<EnsWatchView[]> {
    if (!this.allowedChatIds.has(request.chatId)) {
      throw new EnsWatchError(
        'UNAUTHORIZED_CHAT',
        'This Telegram chat is not authorized to manage agent watches',
      );
    }

    let watches: EnsWatchView[];
    try {
      // Le filtre est passé au port, pas appliqué après : un chat ne doit pas
      // pouvoir lire les watchs d'un autre, même autorisé.
      watches = await this.scheduler.list({ requesterChatId: request.chatId });
    } catch (error) {
      throw new EnsWatchError(
        'SCHEDULER_UNAVAILABLE',
        'The scheduler is unreachable right now, so watches cannot be listed',
        { retryable: true, cause: error },
      );
    }

    return request.includeFinished === true
      ? watches
      : watches.filter((watch) => isActiveWatchStatus(watch.status));
  }
}
