import { DomainError } from "../errors/DomainError.js";
import type { SiweChallenge } from "./SiweChallenge.js";

/** 15 minutes — TTL de demo / tests. */
export const SIWE_BIND_TTL_MS = 15 * 60 * 1000;

export class SiweBindPolicy {
  constructor(public readonly ttlMs: number = SIWE_BIND_TTL_MS) {}

  issue(input: {
    nonce: string;
    channel: string;
    recipientId: string;
    now: Date;
    uiOrigin: string;
  }): SiweChallenge {
    const origin = input.uiOrigin.replace(/\/$/, "");
    return {
      nonce: input.nonce,
      channel: input.channel,
      recipientId: input.recipientId,
      issuedAt: input.now,
      expiresAt: new Date(input.now.getTime() + this.ttlMs),
      uri: `${origin}/siwe?token=${input.nonce}`,
    };
  }

  isExpired(challenge: SiweChallenge, now: Date): boolean {
    return now.getTime() >= challenge.expiresAt.getTime();
  }

  assertActive(challenge: SiweChallenge, now: Date): void {
    if (this.isExpired(challenge, now)) {
      throw new DomainError("SIWE challenge expired. Ask the bot for a new link.");
    }
  }

  wallMessage(challenge: SiweChallenge): string {
    const minutes = Math.round(this.ttlMs / 60_000);
    return [
      "Sign in with Ethereum to talk to DeFiCat.",
      `This link expires in ${minutes} minutes.`,
      "",
      challenge.uri,
    ].join("\n");
  }

  linkedMessage(address: string): string {
    return `Wallet ${address} is linked. Send a message to continue.`;
  }
}