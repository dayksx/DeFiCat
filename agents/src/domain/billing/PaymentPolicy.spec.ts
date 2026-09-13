import { describe, expect, it } from "vitest";
import { DomainError } from "../errors/DomainError.js";
import {
  PAYMENT_SESSION_TTL_MS,
  PaymentPolicy,
} from "./PaymentPolicy.js";

describe("PaymentPolicy", () => {
  const policy = new PaymentPolicy();
  const issuedAt = new Date("2026-09-12T12:00:00.000Z");
  const session = policy.issue({
    nonce: "paynonce1",
    channel: "telegram",
    recipientId: "42",
    payer: "0x224b11F0747c7688a10aCC15F785354aA6493ED6",
    intent: { type: "ens.buy", label: "kikoulol", years: 1 },
    now: issuedAt,
    payTo: "0x224b11F0747c7688a10aCC15F785354aA6493ED6",
    chainId: 84532,
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    uiOrigin: "http://localhost:3001/",
  });

  it("prices an immediate buy at 1 USDC and sets the pay uri", () => {
    expect(session.sku).toBe("ens.buy.now");
    expect(session.amountAtomic).toBe(1_000_000n);
    expect(session.payer).toBe(
      "0x224b11f0747c7688a10acc15f785354aa6493ed6",
    );
    expect(session.uri).toBe("http://localhost:3001/pay?token=paynonce1");
    expect(session.expiresAt.getTime() - issuedAt.getTime()).toBe(
      PAYMENT_SESSION_TTL_MS,
    );
  });

  it("prices a watch arm at 10 USDC", () => {
    const watch = policy.issue({
      nonce: "paynonce2",
      channel: "telegram",
      recipientId: "42",
      payer: "0x224b11F0747c7688a10aCC15F785354aA6493ED6",
      intent: { type: "ens.schedule", label: "takenname", years: 1 },
      now: issuedAt,
      payTo: "0x224b11F0747c7688a10aCC15F785354aA6493ED6",
      chainId: 84532,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      uiOrigin: "http://localhost:3001",
    });
    expect(watch.sku).toBe("ens.watch.arm");
    expect(watch.amountAtomic).toBe(10_000_000n);
  });

  it("is payable just before TTL and expired at TTL", () => {
    const almost = new Date(issuedAt.getTime() + PAYMENT_SESSION_TTL_MS - 1);
    const exact = new Date(issuedAt.getTime() + PAYMENT_SESSION_TTL_MS);
    expect(policy.isExpired(session, almost)).toBe(false);
    expect(() => policy.assertPayable(session, almost)).not.toThrow();
    expect(policy.isExpired(session, exact)).toBe(true);
    expect(() => policy.assertPayable(session, exact)).toThrow(DomainError);
  });

  it("accepts the linked payer case-insensitively and rejects another address", () => {
    expect(() =>
      policy.assertPayer(
        session,
        "0x224B11F0747C7688A10ACC15F785354AA6493ED6",
      ),
    ).not.toThrow();
    expect(() =>
      policy.assertPayer(
        session,
        "0x0000000000000000000000000000000000000001",
      ),
    ).toThrow(DomainError);
  });

  it("puts amount and uri in the wall copy", () => {
    expect(policy.wallMessage(session)).toContain("1 USDC");
    expect(policy.wallMessage(session)).toContain(session.uri);
  });
});
