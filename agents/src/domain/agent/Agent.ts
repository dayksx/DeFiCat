import { AgentId } from "./AgentId.js";
import { DomainError } from "../errors/DomainError.js";

export class Agent {
  constructor(
    public readonly id: AgentId,
    public readonly persona: string,
    /** Ensemble vide = autorisé sur tous les canaux (DeFiChat public). */
    private readonly allowedChannels: ReadonlySet<string> = new Set(),
  ) {}

  assertCanHandle(channel: string): void {
    if (this.allowedChannels.size > 0 && !this.allowedChannels.has(channel)) {
      throw new DomainError(
        `Agent "${this.id}" is not allowed on channel "${channel}"`,
      );
    }
  }
}