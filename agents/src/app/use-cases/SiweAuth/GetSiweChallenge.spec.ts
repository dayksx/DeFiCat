import { describe, expect, it } from "vitest";
import { DomainError } from "../../../domain/errors/DomainError.js";
import { SiweBindPolicy } from "../../../domain/identity/SiweBindPolicy.js";
import type { ClockPort } from "../../ports/clock/ClockPort.js";
import type { IdentityStorePort } from "../../ports/identity/IdentityStorePort.js";
import type {
  SiweChallenge,
  WalletBinding,
} from "../../../domain/identity/SiweChallenge.js";
import { GetSiweChallenge } from "./GetSiweChallenge.js";
import type { SiweIssuance } from "./SiweIssuance.js";

class FakeClock implements ClockPort {
  constructor(public t: Date) {}
  now(): Date {
    return this.t;
  }
}

class EmptyStore implements IdentityStorePort {
  async findBinding(): Promise<WalletBinding | undefined> {
    return undefined;
  }
  async saveBinding(): Promise<void> {}
  async findChallengeByNonce(
    nonce: string,
  ): Promise<SiweChallenge | undefined> {
    if (nonce !== "alive") return undefined;
    return {
      nonce: "alive",
      channel: "telegram",
      recipientId: "1",
      issuedAt: new Date("2026-09-12T12:00:00.000Z"),
      expiresAt: new Date("2026-09-12T12:15:00.000Z"),
      uri: "http://localhost:3001/siwe?token=alive",
    };
  }
  async findOpenChallenge(): Promise<SiweChallenge | undefined> {
    return undefined;
  }
  async saveChallenge(): Promise<void> {}
  async consumeChallenge(): Promise<void> {}
}

const issuance: SiweIssuance = {
  domain: "localhost:3001",
  chainId: 1,
  statement: "Sign in to DeFiCat",
  uiOrigin: "http://localhost:3001",
};

describe("GetSiweChallenge", () => {
  it("returns issuance fields for an active challenge", async () => {
    const uc = new GetSiweChallenge(
      new EmptyStore(),
      new FakeClock(new Date("2026-09-12T12:05:00.000Z")),
      new SiweBindPolicy(),
      issuance,
    );
    const view = await uc.execute("alive");
    expect(view.nonce).toBe("alive");
    expect(view.domain).toBe("localhost:3001");
    expect(view.issuedAt).toBe("2026-09-12T12:00:00.000Z");
  });

  it("rejects an unknown token", async () => {
    const uc = new GetSiweChallenge(
      new EmptyStore(),
      new FakeClock(new Date("2026-09-12T12:05:00.000Z")),
      new SiweBindPolicy(),
      issuance,
    );
    await expect(uc.execute("nope")).rejects.toBeInstanceOf(DomainError);
  });

  it("rejects an expired challenge", async () => {
    const uc = new GetSiweChallenge(
      new EmptyStore(),
      new FakeClock(new Date("2026-09-12T12:15:00.000Z")),
      new SiweBindPolicy(),
      issuance,
    );
    await expect(uc.execute("alive")).rejects.toBeInstanceOf(DomainError);
  });
});

