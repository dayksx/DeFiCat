export const SIWE_VERIFIER_PORT = Symbol("SiweVerifierPort");

export type SiweVerifyInput = {
  message: string;
  signature: string;
  address: string;
  nonce: string;
  domain: string;
  uri: string;
  chainId: number;
  statement: string;
  issuedAt: Date;
  expirationTime: Date;
  now: Date;
};

export interface SiweVerifierPort {
  /**
   * Reconstruit le message canonique, exige `message === expected`,
   * puis vérifie la signature EIP-191. Retourne l’adresse checksummée.
   */
  verify(input: SiweVerifyInput): Promise<{ address: string }>;
}