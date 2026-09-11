import { describe, expect, it } from 'vitest';
import { POLL_MAX_MS, POLL_MIN_MS, nextPollMs } from './pollSchedule.js';
import type { QuoteView } from '../activities/ensDrop.activities.js';

const HOUR_MS = 60 * 60 * 1000;
const ETH = 10n ** 18n;

const NOW_MS = Date.UTC(2026, 8, 11, 0, 0, 0);
const DROP_UNIX = NOW_MS / 1000 - 3600;

/** Budget du watch : 0,02 ETH. */
const MAX_WEI = (ETH / 50n).toString();
/** Prix hors premium, donc le plancher que la décote ne fera jamais descendre. */
const FLOOR_WEI = ETH / 200n;
/** Ce qu'il reste au premium pour rentrer dans le budget. */
const HEADROOM_WEI = BigInt(MAX_WEI) - FLOOR_WEI;

function quoteOf(
  premiumWei: bigint,
  overrides: Partial<QuoteView> = {},
): QuoteView {
  return {
    available: true,
    withinBudget: false,
    premiumWei: premiumWei.toString(),
    totalWei: (FLOOR_WEI + premiumWei).toString(),
    gracePeriodEndUnix: DROP_UNIX,
    ...overrides,
  };
}

describe('nextPollMs', () => {
  it('waits for the announced drop date while the name is still held', () => {
    const quote = quoteOf(0n, {
      available: false,
      gracePeriodEndUnix: NOW_MS / 1000 + 3600,
    });

    expect(nextPollMs(quote, MAX_WEI, NOW_MS)).toBe(HOUR_MS);
  });

  it('caps the wait so a move of the ETH price is never missed for long', () => {
    // Premium mille fois le budget restant, soit une dizaine de jours de décote.
    expect(nextPollMs(quoteOf(HEADROOM_WEI * 1000n), MAX_WEI, NOW_MS)).toBe(
      POLL_MAX_MS,
    );
  });

  it('shortens the wait as the premium approaches the budget', () => {
    const far = nextPollMs(quoteOf(HEADROOM_WEI * 4n), MAX_WEI, NOW_MS);
    const near = nextPollMs(quoteOf((HEADROOM_WEI * 11n) / 10n), MAX_WEI, NOW_MS);

    expect(near).toBeLessThan(far);
    // Dix pour cent au-dessus du budget, c'est moins de trois heures de décote.
    expect(near).toBeGreaterThan(2 * HOUR_MS);
    expect(near).toBeLessThan(3 * HOUR_MS);
  });

  it('falls back to the floor once the premium is all but gone', () => {
    expect(nextPollMs(quoteOf(HEADROOM_WEI), MAX_WEI, NOW_MS)).toBe(POLL_MIN_MS);
  });

  it('stops chasing the decay when the price floor alone is over budget', () => {
    const quote = quoteOf(0n, { totalWei: (BigInt(MAX_WEI) * 2n).toString() });

    expect(nextPollMs(quote, MAX_WEI, NOW_MS)).toBe(POLL_MAX_MS);
  });

  it('never hands the workflow a wait outside its bounds', () => {
    for (const factor of [1n, 2n, 7n, 100n, 10_000n, 1_000_000n]) {
      const wait = nextPollMs(quoteOf(HEADROOM_WEI * factor), MAX_WEI, NOW_MS);

      expect(wait).toBeGreaterThanOrEqual(POLL_MIN_MS);
      expect(wait).toBeLessThanOrEqual(POLL_MAX_MS);
      expect(Number.isInteger(wait)).toBe(true);
    }
  });
});
