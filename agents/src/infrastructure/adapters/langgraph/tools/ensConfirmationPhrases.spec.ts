import { describe, expect, it } from 'vitest';
import {
  buyConfirmationPhrase,
  normalizeConfirmation,
  watchConfirmationPhrase,
} from './ensConfirmationPhrases.js';

describe('ens confirmation phrases', () => {
  it('spells out the buy phrase with the duration', () => {
    expect(buyConfirmationPhrase('vitalik.eth', 1)).toBe(
      'CONFIRM BUY VITALIK.ETH FOR 1 YEAR',
    );
    expect(buyConfirmationPhrase('vitalik.eth', 2)).toBe(
      'CONFIRM BUY VITALIK.ETH FOR 2 YEARS',
    );
  });

  it('keeps the watch phrase distinct from the buy phrase', () => {
    expect(watchConfirmationPhrase('vitalik.eth', 1)).toBe(
      'CONFIRM WATCH AND BUY VITALIK.ETH FOR 1 YEAR',
    );
    expect(watchConfirmationPhrase('vitalik', 1)).toBe(
      'CONFIRM WATCH AND BUY VITALIK.ETH FOR 1 YEAR',
    );
    expect(watchConfirmationPhrase('vitalik.eth', 1)).not.toBe(
      buyConfirmationPhrase('vitalik.eth', 1),
    );
  });

  it('accepts sloppy spacing and casing from Telegram', () => {
    expect(
      normalizeConfirmation('  confirm  watch and buy vitalik.eth for 1 year '),
    ).toBe(watchConfirmationPhrase('vitalik.eth', 1));
  });
});
