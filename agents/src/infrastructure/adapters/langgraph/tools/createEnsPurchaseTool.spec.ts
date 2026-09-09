import { describe, expect, it } from 'vitest';
import { authorizeEnsPurchase } from './createEnsPurchaseTool.js';

describe('authorizeEnsPurchase', () => {
  const allowedTelegramChatIds = new Set(['123']);

  it('requires an allowlisted Telegram chat', () => {
    expect(
      authorizeEnsPurchase({
        threadId: 'defichat:telegram:999',
        latestUserText: 'CONFIRM BUY DEFICAT.ETH FOR 1 YEAR',
        allowedTelegramChatIds,
        name: 'deficat.eth',
        years: 1,
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('not authorized'),
    });
  });

  it('requires the exact confirmation as the latest user message', () => {
    expect(
      authorizeEnsPurchase({
        threadId: 'defichat:telegram:123',
        latestUserText: 'yes buy it',
        allowedTelegramChatIds,
        name: 'deficat.eth',
        years: 1,
      }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('confirmation is missing'),
    });
  });

  it('allows an exact confirmation from an allowlisted chat', () => {
    expect(
      authorizeEnsPurchase({
        threadId: 'defichat:telegram:123',
        latestUserText: '  confirm   buy deficat.eth for 2 years ',
        allowedTelegramChatIds,
        name: 'deficat.eth',
        years: 2,
      }),
    ).toEqual({ allowed: true });
  });
});
