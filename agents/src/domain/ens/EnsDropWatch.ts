export type EnsDropWatchStatus =
  | 'scheduled'
  | 'arming'
  | 'committed'
  | 'buying'
  | 'bought'
  | 'cancelled'
  | 'expired'   // owner a renew
  | 'failed';

const ACTIVE: ReadonlySet<EnsDropWatchStatus> = new Set([
  'scheduled',
  'arming',
  'committed',
  'buying',
]);

/** Un watch actif peut encore dépenser : il n'est ni abouti ni éteint. */
export function isActiveWatchStatus(status: EnsDropWatchStatus): boolean {
  return ACTIVE.has(status);
}

export type EnsDropWatch = {
  label: string;
  name: string;
  years: number;
  /** Dérivé de `years` une seule fois, à l'armement du watch. */
  durationSeconds: number;
  requesterChatId: string;
  maxWei: string;
  gracePeriodEndUnix: number; // snapshot, re-validé avant commit
};