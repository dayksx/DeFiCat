import { DomainError } from "../../../domain/errors/DomainError.js";
import { EthereumAddress } from "../../../domain/identity/EthereumAddress.js";
import type { SiweBindPolicy } from "../../../domain/identity/SiweBindPolicy.js";
import type { ClockPort } from "../../ports/clock/ClockPort.js";
import type { IdentityStorePort } from "../../ports/identity/IdentityStorePort.js";
import type { SiweVerifierPort } from "../../ports/identity/SiweVerifierPort.js";
import type { OutboundMessagingPort } from "../../ports/messaging/OutboundMessagingPort.js";
import type { SiweIssuance } from "./SiweIssuance.js";

export type CompleteSiweBindInput = {
  token: string;
  address: string;
  message: string;
  signature: string;
};

export class CompleteSiweBind {
  constructor(
    private readonly identities: IdentityStorePort,
    private readonly verifier: SiweVerifierPort,
    private readonly messaging: OutboundMessagingPort,
    private readonly clock: ClockPort,
    private readonly policy: SiweBindPolicy,
    private readonly issuance: SiweIssuance,
  ) {}

  public async execute(
    input: CompleteSiweBindInput,
  ): Promise<{ address: string }> {
    const challenge = await this.identities.findChallengeByNonce(input.token);
    if (challenge === undefined) {
      throw new DomainError("Unknown or already used SIWE challenge");
    }
    const now = this.clock.now();
    this.policy.assertActive(challenge, now);

    const address = EthereumAddress.of(input.address);
    const verified = await this.verifier.verify({
      message: input.message,
      signature: input.signature,
      address: address.value,
      nonce: challenge.nonce,
      domain: this.issuance.domain,
      uri: challenge.uri,
      chainId: this.issuance.chainId,
      statement: this.issuance.statement,
      issuedAt: challenge.issuedAt,
      expirationTime: challenge.expiresAt,
      now,
    });

    await this.identities.consumeChallenge(challenge.nonce);
    await this.identities.saveBinding({
      channel: challenge.channel,
      recipientId: challenge.recipientId,
      address: verified.address.toLowerCase(),
      boundAt: now,
    });
    await this.messaging.send({
      channel: challenge.channel,
      recipientId: challenge.recipientId,
      message: this.policy.linkedMessage(verified.address),
    });
    return { address: verified.address };
  }
}