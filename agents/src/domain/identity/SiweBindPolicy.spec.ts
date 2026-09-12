import { describe, expect, it } from "vitest";
import { DomainError } from "../errors/DomainError.js";
import { SIWE_BIND_TTL_MS, SiweBindPolicy } from "./SiweBindPolicy.js";

describe("SiweBindPolicy", () => {
  const policy = new SiweBindPolicy();
  const issuedAt = new Date("2026-09-12T12:00:00.000Z");

  const challenge = policy.issue({
    nonce: "abc12345defg6789",
    channel: "telegram",
    recipientId: "42",
    now: issuedAt,
    uiOrigin: "http://localhost:3001/",
  });

  it("sets uri and 15-minute expiry", () => {
    expect(challenge.uri).toBe(
      "http://localhost:3001/siwe?token=abc12345defg6789",
    );
    expect(challenge.expiresAt.getTime() - issuedAt.getTime()).toBe(
      SIWE_BIND_TTL_MS,
    );
  });

  it("is active just before TTL and expired at TTL", () => {
    const almost = new Date(issuedAt.getTime() + SIWE_BIND_TTL_MS - 1);
    const exact = new Date(issuedAt.getTime() + SIWE_BIND_TTL_MS);
    expect(policy.isExpired(challenge, almost)).toBe(false);
    expect(() => policy.assertActive(challenge, almost)).not.toThrow();
    expect(policy.isExpired(challenge, exact)).toBe(true);
    expect(() => policy.assertActive(challenge, exact)).toThrow(DomainError);
  });

  it("puts the uri in the wall copy", () => {
    expect(policy.wallMessage(challenge)).toContain(challenge.uri);
    expect(policy.wallMessage(challenge)).toContain("15 minutes");
  });
});