import { describe, expect, it } from "vitest";
import { DomainError } from "../../../domain/errors/DomainError.js";
import { SiweBindPolicy } from "../../../domain/identity/SiweBindPolicy.js";
import type { ClockPort } from "../../ports/clock/ClockPort.js";
import type { IdentityStorePort } from "../../ports/identity/IdentityStorePort.js";
import type { SiweVerifierPort } from "../../ports/identity/SiweVerifierPort.js";
import type {
  OutboundMessage,
  OutboundMessagingPort,
} from "../../ports/messaging/OutboundMessagingPort.js";
import type {
  SiweChallenge,
  WalletBinding,
} from "../../../domain/identity/SiweChallenge.js";
import { CompleteSiweBind } from "./CompleteSiweBind.js";
import type { SiweIssuance } from "./SiweIssuance.js";

const ADDR = "0xa0cf798816d4b9b9866b5330eea46a18382f251e";
const issuedAt = new Date("2026-09-12T12:00:00.000Z");

class FakeClock implements ClockPort {
  now(): Date {
    return new Date("2026-09-12T12:05:00.000Z");
  }
}

class FakeMessaging implements OutboundMessagingPort {
  sent: OutboundMessage[] = [];
  async send(m: OutboundMessage): Promise<void> {
    this.sent.push(m);
  }
}

class FakeVerifier implements SiweVerifierPort {
  lastMessage: string | undefined;
  async verify(input: { message: string; address: string }) {
    this.lastMessage = input.message;
    return { address: "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e" };
  }
}

class Store implements IdentityStorePort {
  challenge: SiweChallenge | undefined = {
    nonce: "n1",
    channel: "telegram",
    recipientId: "42",
    issuedAt,
    expiresAt: new Date("2026-09-12T12:15:00.000Z"),
    uri: "http://localhost:3001/siwe?token=n1",
  };
  bindings: WalletBinding[] = [];

  async findBinding() {
    return undefined;
  }
  async saveBinding(b: WalletBinding) {
    this.bindings.push(b);
  }
  async findChallengeByNonce(nonce: string) {
    return this.challenge?.nonce === nonce ? this.challenge : undefined;
  }
  async findOpenChallenge() {
    return this.challenge;
  }
  async saveChallenge() {}
  async consumeChallenge() {
    this.challenge = undefined;
  }
}

const issuance: SiweIssuance = {
  domain: "localhost:3001",
  chainId: 1,
  statement: "Sign in to DeFiCat",
  uiOrigin: "http://localhost:3001",
};

function uc(store = new Store(), verifier = new FakeVerifier()) {
  const messaging = new FakeMessaging();
  return {
    messaging,
    verifier,
    store,
    complete: new CompleteSiweBind(
      store,
      verifier,
      messaging,
      new FakeClock(),
      new SiweBindPolicy(),
      issuance,
    ),
  };
}

describe("CompleteSiweBind", () => {
  it("binds the chat, consumes the nonce, and notifies Telegram", async () => {
    const { complete, store, messaging } = uc();
    const result = await complete.execute({
      token: "n1",
      address: ADDR,
      message: "siwe",
      signature: "0xsig",
    });
    expect(result.address).toBe("0xA0Cf798816D4b9b9866b5330EEa46a18382f251e");
    expect(store.challenge).toBeUndefined();
    expect(store.bindings[0]?.recipientId).toBe("42");
    expect(store.bindings[0]?.address).toBe(ADDR);
    expect(messaging.sent[0]?.recipientId).toBe("42");
    expect(messaging.sent[0]?.message).toContain("0xA0Cf");
  });

  it("rejects a second verify on the same token", async () => {
    const { complete } = uc();
    await complete.execute({
      token: "n1",
      address: ADDR,
      message: "siwe",
      signature: "0xsig",
    });
    await expect(
      complete.execute({
        token: "n1",
        address: ADDR,
        message: "siwe",
        signature: "0xsig",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});