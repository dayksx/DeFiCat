import { describe, expect, it } from "vitest";
import { Agent } from "./Agent.js";
import { AgentId } from "./AgentId.js";
import { DomainError } from "../errors/DomainError.js";

describe("Agent", () => {
  it("allows any channel when the allowlist is empty", () => {
    const agent = new Agent(AgentId.of("defichat"), "helpful DeFi assistant");
    expect(() => agent.assertCanHandle("telegram")).not.toThrow();
    expect(() => agent.assertCanHandle("http")).not.toThrow();
  });

  it("rejects a channel outside a non-empty allowlist", () => {
    const agent = new Agent(AgentId.of("defichat"), "p", new Set(["slack"]));
    expect(() => agent.assertCanHandle("telegram")).toThrow(DomainError);
  });
});