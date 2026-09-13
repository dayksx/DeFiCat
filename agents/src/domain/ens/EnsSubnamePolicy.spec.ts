import { describe, expect, it } from 'vitest';
import { DomainError } from '../errors/DomainError.js';
import { EnsSubnamePolicy } from './EnsSubnamePolicy.js';

describe('EnsSubnamePolicy', () => {
  const policy = new EnsSubnamePolicy();

  it('normalizes a direct subname of a second-level eth name', () => {
    expect(policy.validate({ name: '  ME.Kikoulol.ETH ' })).toEqual({
      name: 'me.kikoulol.eth',
      label: 'me',
      parentName: 'kikoulol.eth',
    });
  });

  it.each([
    'kikoulol.eth',
    'deep.me.kikoulol.eth',
    '-me.kikoulol.eth',
    'me.kikoulol.com',
    'mé.kikoulol.eth',
  ])('rejects unsupported name %s', (name) => {
    expect(() => policy.validate({ name })).toThrow(DomainError);
  });
});
