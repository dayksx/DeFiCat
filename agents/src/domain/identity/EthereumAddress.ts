import { DomainError } from "../errors/DomainError.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export class EthereumAddress {
  private constructor(public readonly value: string) {}

  static of(raw: string): EthereumAddress {
    const v = raw.trim();
    if (!ADDRESS.test(v)) {
      throw new DomainError("Invalid Ethereum address");
    }
    return new EthereumAddress(v.toLowerCase());
  }

  toString(): string {
    return this.value;
  }
}