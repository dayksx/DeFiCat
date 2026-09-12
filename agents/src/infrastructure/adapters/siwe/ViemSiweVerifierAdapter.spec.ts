import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { DomainError } from "../../../domain/errors/DomainError.js";
import { ViemSiweVerifierAdapter } from "./ViemSiweVerifierAdapter.js";

const issuedAt = new Date("2026-09-12T12:00:00.000Z");
const expirationTime = new Date("2026-09-12T12:15:00.000Z");
const now = new Date("2026-09-12T12:05:00.000Z");

describe("ViemSiweVerifierAdapter", () => {
  it("accepts a signature over the canonical message", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const fields = {
      address: account.address,
      chainId: 1,
      domain: "localhost:3001",
      nonce: "abc12345defg6789",
      uri: "http://localhost:3001/siwe?token=abc12345defg6789",
      version: "1" as const,
      statement: "Sign in to DeFiCat",
      issuedAt,
      expirationTime,
    };
    const message = createSiweMessage(fields);
    const signature = await account.signMessage({ message });
    const adapter = new ViemSiweVerifierAdapter();

    const result = await adapter.verify({
      ...fields,
      message,
      signature,
      now,
    });
    expect(result.address).toBe(account.address);
  });

  it("rejects a tampered statement", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = createSiweMessage({
      address: account.address,
      chainId: 1,
      domain: "localhost:3001",
      nonce: "abc12345defg6789",
      uri: "http://localhost:3001/siwe?token=abc12345defg6789",
      version: "1",
      statement: "I am an attacker",
      issuedAt,
      expirationTime,
    });
    const signature = await account.signMessage({ message });
    const adapter = new ViemSiweVerifierAdapter();

    await expect(
      adapter.verify({
        message,
        signature,
        address: account.address,
        nonce: "abc12345defg6789",
        domain: "localhost:3001",
        uri: "http://localhost:3001/siwe?token=abc12345defg6789",
        chainId: 1,
        statement: "Sign in to DeFiCat",
        issuedAt,
        expirationTime,
        now,
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});