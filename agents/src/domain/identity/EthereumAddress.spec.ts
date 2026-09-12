import { describe, expect, it } from "vitest";
import { EthereumAddress } from "./EthereumAddress.js";
import { DomainError } from "../errors/DomainError.js";

describe("EthereumAddress", () => {
  it("lowercases a valid address", () => {
    const a = EthereumAddress.of(
      "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e",
    );
    expect(a.value).toBe("0xa0cf798816d4b9b9866b5330eea46a18382f251e");
  });

  it("rejects truncated input", () => {
    expect(() => EthereumAddress.of("0xabc")).toThrow(DomainError);
  });
});