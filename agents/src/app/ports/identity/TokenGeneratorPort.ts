export const TOKEN_GENERATOR_PORT = Symbol("TokenGeneratorPort");

export interface TokenGeneratorPort {
  nextSiweNonce(): string;
}