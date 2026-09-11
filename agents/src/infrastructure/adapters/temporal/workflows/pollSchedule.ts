import type { QuoteView } from '../activities/ensDrop.activities.js';

/** Plancher : assez serré pour ne pas rater la fenêtre une fois le prix proche. */
export const POLL_MIN_MS = 30_000;

/**
 * Plafond : assez lâche pour ne rien coûter sur trois semaines de décote, assez
 * serré pour rattraper un mouvement du cours ETH que l'estimation ignore.
 */
export const POLL_MAX_MS = 6 * 60 * 60 * 1000;

/** Le premium ENS est divisé par deux chaque jour de la décote. */
const PREMIUM_HALVING_MS = 24 * 60 * 60 * 1000;

/**
 * On ne dort qu'une fraction de l'estimation : se réveiller trop tôt ne coûte
 * qu'une cotation, trop tard coûte le nom.
 */
const IMPATIENCE = 0.8;

/**
 * Combien attendre avant la prochaine cotation.
 *
 * Sonder toutes les trente secondes le temps que le premium retombe ferait
 * heurter au workflow le plafond d'historique du serveur bien avant que le prix
 * devienne atteignable — l'historique est rejoué en entier à chaque réveil,
 * donc il ne peut pas être élagué.
 *
 * Mais la décote est une fonction connue du temps : à prix donné, on sait
 * combien de divisions par deux séparent encore le premium du budget. On dort
 * jusque-là, on recote, on recommence. L'attente se resserre d'elle-même à
 * mesure qu'on approche, et la boucle coûte quelques dizaines d'appels au lieu
 * de plusieurs dizaines de milliers.
 */
export function nextPollMs(
  quote: QuoteView,
  maxWei: string,
  nowMs: number,
): number {
  // Pas encore libéré : rien ne peut bouger avant la date annoncée.
  if (!quote.available) {
    return clamp(quote.gracePeriodEndUnix * 1000 - nowMs);
  }

  const floorWei = BigInt(quote.totalWei) - BigInt(quote.premiumWei);
  const headroomWei = BigInt(maxWei) - floorWei;

  // Le prix hors premium dépasse déjà le budget : attendre la décote n'y
  // changera rien, seul le cours ETH le peut. On repasse donc de loin en loin.
  if (headroomWei <= 0n) return POLL_MAX_MS;

  const halvings = Math.log2(Number(quote.premiumWei) / Number(headroomWei));
  return clamp(halvings * PREMIUM_HALVING_MS * IMPATIENCE);
}

function clamp(ms: number): number {
  if (Number.isNaN(ms)) return POLL_MAX_MS;
  return Math.round(Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, ms)));
}
