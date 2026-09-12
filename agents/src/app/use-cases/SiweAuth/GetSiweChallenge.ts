import { DomainError } from "../../../domain/errors/DomainError.js";
import type { SiweBindPolicy } from "../../../domain/identity/SiweBindPolicy.js";
import type { ClockPort } from "../../ports/clock/ClockPort.js";
import type { IdentityStorePort } from "../../ports/identity/IdentityStorePort.js";
import type { SiweIssuance } from "./SiweIssuance.js";

export type SiweChallengeView = {
  nonce: string;
  domain: string;
  uri: string;
  chainId: number;
  statement: string;
  version: "1";
  issuedAt: string;
  expirationTime: string;
};

export class GetSiweChallenge {
  constructor(
    private readonly identities: IdentityStorePort,
    private readonly clock: ClockPort,
    private readonly policy: SiweBindPolicy,
    private readonly issuance: SiweIssuance,
  ) {}

  public async execute(token: string): Promise<SiweChallengeView> {
    const challenge = await this.identities.findChallengeByNonce(token);
    if (challenge === undefined) {
      throw new DomainError("Unknown or already used SIWE challenge");
    }
    this.policy.assertActive(challenge, this.clock.now());
    return {
      nonce: challenge.nonce,
      domain: this.issuance.domain,
      uri: challenge.uri,
      chainId: this.issuance.chainId,
      statement: this.issuance.statement,
      version: "1",
      issuedAt: challenge.issuedAt.toISOString(),
      expirationTime: challenge.expiresAt.toISOString(),
    };
  }
}