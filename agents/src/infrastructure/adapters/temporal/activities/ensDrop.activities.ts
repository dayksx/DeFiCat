/**
 * Contrat entre le workflow et le worker. Uniquement des types : le workflow
 * s'en sert via `proxyActivities`, le worker déclare un objet de ce type et se
 * fait donc corriger par le compilateur s'il oublie une activité ou dérive sur
 * une signature.
 *
 * Les payloads traversent le réseau et sont rejoués depuis l'historique, donc
 * uniquement des valeurs sérialisables : pas de `bigint`, les montants sont des
 * chaînes décimales de wei.
 */

export type QuoteView = {
  available: boolean;
  withinBudget: boolean;
  totalWei: string;
  premiumWei: string;
  /** 0 quand le nom n'a plus d'enregistrement connu, donc plus de date de libération. */
  gracePeriodEndUnix: number;
};

export type RefreshQuoteInput = {
  label: string;
  years: number;
  maxWei: string;
};

export type CommitNameInput = {
  label: string;
  durationSeconds: number;
  /**
   * Fourni par le workflow et donc stable au replay : un retour d'activité
   * rejoué réutilise le même commitment au lieu d'en miner un second.
   */
  secret: string;
};

export type CommitNameResult = {
  secret: string;
  commitmentTransactionHash: string;
};

export type RegisterNameInput = {
  label: string;
  durationSeconds: number;
  maxWei: string;
  secret: string;
  commitmentTransactionHash: string;
};

export type RegisterNameResult = {
  registrationTransactionHash: string;
  totalPaidWei: string;
};

export type NotifyChatInput = {
  chatId: string;
  message: string;
};

export type EnsDropActivities = {
  refreshQuote(input: RefreshQuoteInput): Promise<QuoteView>;
  commitName(input: CommitNameInput): Promise<CommitNameResult>;
  registerName(input: RegisterNameInput): Promise<RegisterNameResult>;
  notifyChat(input: NotifyChatInput): Promise<void>;
};
