import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors/DomainError.js';
import { EnsPurchasePolicy } from './EnsPurchasePolicy.js';

describe('EnsPurchasePolicy', () => {
  const policy = new EnsPurchasePolicy();

  it('normalizes a valid .eth name', () => {
    expect(policy.validate({ label: 'DeFi-Cat.ETH', years: 2 })).toEqual({
      label: 'defi-cat',
      name: 'defi-cat.eth',
      years: 2,
      durationSeconds: 63_072_000,
    });
  });

  it.each(['ab', '-deficat', 'deficat-', 'foo.bar.eth'])(
    'rejects invalid label %s',
    (label) => {
      expect(() => policy.validate({ label, years: 1 })).toThrow(DomainError);
    },
  );

  it('rejects a price above budget', () => {
    expect(() => policy.assertWithinBudget('101', '100')).toThrow(DomainError);
  });
});
