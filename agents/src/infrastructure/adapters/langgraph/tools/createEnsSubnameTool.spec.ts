import { describe, expect, it } from 'vitest';
import { authorizeEnsSubnamePurchase } from './createEnsSubnameTool.js';

describe('authorizeEnsSubnamePurchase', () => {
  const allowedTelegramChatIds = new Set(['123']);

  it('accepts the exact normalized confirmation from an allowed chat', () => {
    expect(
      authorizeEnsSubnamePurchase({
        threadId: 'defichat:telegram:123',
        latestUserText: ' confirm   buy me.kikoulol.eth ',
        allowedTelegramChatIds,
        name: 'me.kikoulol.eth',
      }),
    ).toEqual({ allowed: true });
  });

  it('rejects another chat or confirmation', () => {
    expect(
      authorizeEnsSubnamePurchase({
        threadId: 'defichat:telegram:999',
        latestUserText: 'CONFIRM BUY ME.KIKOULOL.ETH',
        allowedTelegramChatIds,
        name: 'me.kikoulol.eth',
      }),
    ).toEqual({ allowed: false });
    expect(
      authorizeEnsSubnamePurchase({
        threadId: 'defichat:telegram:123',
        latestUserText: 'yes',
        allowedTelegramChatIds,
        name: 'me.kikoulol.eth',
      }),
    ).toEqual({ allowed: false });
  });
});
