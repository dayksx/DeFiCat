import type {
  EnsDropWatch,
  EnsDropWatchStatus,
} from '../../../domain/ens/EnsDropWatch.js';

export const ENS_WATCH_SCHEDULER_PORT = Symbol('EnsWatchSchedulerPort');

export type EnsWatchView = EnsDropWatch & {
  workflowId: string;
  status: EnsDropWatchStatus;
  /** ISO 8601 UTC. */
  armedAt: string;
};

export type EnsWatchFilter = {
  /** Restreint aux watchs armés par ce chat. */
  requesterChatId?: string;
};

export interface EnsWatchSchedulerPort {
  start(watch: EnsDropWatch): Promise<{ workflowId: string }>;
  cancel(workflowId: string): Promise<void>;
  describe(workflowId: string): Promise<EnsWatchView>;
  /**
   * Rend aussi les watchs terminés : « qu'as-tu acheté le mois dernier » est
   * une question aussi légitime que « que surveilles-tu ».
   */
  list(filter?: EnsWatchFilter): Promise<EnsWatchView[]>;
}

export function workflowIdFor(label: string): string {
  return `ens-drop:${label}`;
}

/** Failure modes every EnsWatchSchedulerPort implementation must map its errors onto. */
export type EnsWatchSchedulerFailure =
  | 'ALREADY_STARTED'
  | 'NOT_FOUND'
  | 'UNAVAILABLE';

export class EnsWatchSchedulerError extends Error {
  readonly failure: EnsWatchSchedulerFailure;

  constructor(
    failure: EnsWatchSchedulerFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'EnsWatchSchedulerError';
    this.failure = failure;
  }
}
