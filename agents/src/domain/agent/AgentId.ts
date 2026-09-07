import { DomainError } from "../errors/DomainError.js";

export class AgentId {
    private constructor(public readonly value: string) {}
  
    static of(raw: string): AgentId {
      const v = raw.trim();
      if (v === "") throw new DomainError("AgentId cannot be empty");
      return new AgentId(v);
    }
  
    toString(): string {
      return this.value;
    }
  }