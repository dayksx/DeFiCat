import { describe, expect, it } from "vitest";
import { HandleIncomingMessage } from "./HandleIncomingMessage.js";
import { Agent } from "../../../domain/agent/Agent.js";
import { AgentId } from "../../../domain/agent/AgentId.js";
import { SiweBindPolicy } from "../../../domain/identity/SiweBindPolicy.js";
import type { ClockPort } from "../../ports/clock/ClockPort.js";
import type { ConversationPort } from "../../ports/conversation/ConversationPort.js";
import type { IdentityStorePort } from "../../ports/identity/IdentityStorePort.js";
import type { TokenGeneratorPort } from "../../ports/identity/TokenGeneratorPort.js";
import type {
  OutboundMessagingPort,
  OutboundMessage,
} from "../../ports/messaging/OutboundMessagingPort.js";
import type {
  SiweChallenge,
  WalletBinding,
} from "../../../domain/identity/SiweChallenge.js";
import { recipientKey } from "../../../domain/identity/SiweChallenge.js";
import type { SiweIssuance } from "../SiweAuth/SiweIssuance.js";

class FakeConversation implements ConversationPort {
  calls = 0;
  lastThreadId: string | undefined;
  lastIdentity: { address: string; boundAt: Date } | undefined;

  async reply(
    threadId: string,
    message: string,
    identity: { address: string; boundAt: Date },
  ): Promise<string> {
    this.calls += 1;
    this.lastThreadId = threadId;
    this.lastIdentity = identity;
    return `ok:${message}`;
  }
}

class FakeMessaging implements OutboundMessagingPort {
  sent: OutboundMessage[] = [];
  async send(m: OutboundMessage): Promise<void> {
    this.sent.push(m);
  }
}

class FakeClock implements ClockPort {
  constructor(private t: Date) {}
  now(): Date {
    return this.t;
  }
}

class FakeTokens implements TokenGeneratorPort {
  constructor(private readonly nonce: string) {}
  nextSiweNonce(): string {
    return this.nonce;
  }
}

class MemoryIdentities implements IdentityStorePort {
  bindings = new Map<string, WalletBinding>();
  challenges = new Map<string, SiweChallenge>();
  open = new Map<string, string>();

  async findBinding(channel: string, recipientId: string) {
    return this.bindings.get(recipientKey(channel, recipientId));
  }
  async saveBinding(binding: WalletBinding) {
    this.bindings.set(
      recipientKey(binding.channel, binding.recipientId),
      binding,
    );
  }
  async findChallengeByNonce(nonce: string) {
    return this.challenges.get(nonce);
  }
  async findOpenChallenge(channel: string, recipientId: string) {
    const nonce = this.open.get(recipientKey(channel, recipientId));
    return nonce === undefined ? undefined : this.challenges.get(nonce);
  }
  async saveChallenge(challenge: SiweChallenge) {
    this.challenges.set(challenge.nonce, challenge);
    this.open.set(
      recipientKey(challenge.channel, challenge.recipientId),
      challenge.nonce,
    );
  }
  async consumeChallenge(nonce: string) {
    const c = this.challenges.get(nonce);
    this.challenges.delete(nonce);
    if (c !== undefined) {
      this.open.delete(recipientKey(c.channel, c.recipientId));
    }
  }
}

const issuance: SiweIssuance = {
  domain: "localhost:3001",
  chainId: 1,
  statement: "Sign in to DeFiCat",
  uiOrigin: "http://localhost:3001",
};

function setup(opts?: { bound?: boolean; now?: Date }) {
  const now = opts?.now ?? new Date("2026-09-12T12:00:00.000Z");
  const conversation = new FakeConversation();
  const messaging = new FakeMessaging();
  const identities = new MemoryIdentities();
  if (opts?.bound) {
    identities.bindings.set("telegram:999", {
      channel: "telegram",
      recipientId: "999",
      address: "0xabc",
      boundAt: now,
    });
  }
  const uc = new HandleIncomingMessage(
    conversation,
    messaging,
    new Agent(AgentId.of("defichat"), "p"),
    identities,
    new FakeTokens("nonce-1"),
    new FakeClock(now),
    new SiweBindPolicy(),
    issuance,
  );
  return { uc, conversation, messaging, identities };
}

describe("HandleIncomingMessage", () => {
  it("sends the SIWE wall and does not call the LLM when unbound", async () => {
    const { uc, conversation, messaging } = setup();

    await uc.execute({
      channel: "telegram",
      recipientId: "999",
      message: "gm",
    });

    expect(conversation.calls).toBe(0);
    expect(messaging.sent[0]?.message).toContain(
      "http://localhost:3001/siwe?token=nonce-1",
    );
  });

  it("reuses a still-valid challenge instead of minting a new nonce", async () => {
    const { uc, identities, messaging } = setup();
    await uc.execute({
      channel: "telegram",
      recipientId: "999",
      message: "gm",
    });
    await uc.execute({
      channel: "telegram",
      recipientId: "999",
      message: "hello again",
    });

    expect(identities.challenges.size).toBe(1);
    expect(messaging.sent[1]?.message).toContain("token=nonce-1");
  });

  it("replies via the LLM when a wallet is already linked", async () => {
    const { uc, conversation, messaging } = setup({ bound: true });

    await uc.execute({
      channel: "telegram",
      recipientId: "999",
      message: "gm",
    });

    expect(conversation.lastThreadId).toBe("defichat:telegram:999");
    expect(conversation.lastIdentity).toEqual({
      address: "0xabc",
      boundAt: new Date("2026-09-12T12:00:00.000Z"),
    });
    expect(messaging.sent[0]?.message).toBe("ok:gm");
  });
});