import type { IdentityStorePort } from "../../../app/ports/identity/IdentityStorePort.js";
import type {
  SiweChallenge,
  WalletBinding,
} from "../../../domain/identity/SiweChallenge.js";
import { recipientKey } from "../../../domain/identity/SiweChallenge.js";

export class InMemoryIdentityStore implements IdentityStorePort {
  private readonly challengesByNonce = new Map<string, SiweChallenge>();
  private readonly openNonceByRecipient = new Map<string, string>();
  private readonly bindingsByRecipient = new Map<string, WalletBinding>();

  async findBinding(channel: string, recipientId: string) {
    return this.bindingsByRecipient.get(recipientKey(channel, recipientId));
  }

  async saveBinding(binding: WalletBinding) {
    this.bindingsByRecipient.set(
      recipientKey(binding.channel, binding.recipientId),
      binding,
    );
  }

  async findChallengeByNonce(nonce: string) {
    return this.challengesByNonce.get(nonce);
  }

  async findOpenChallenge(channel: string, recipientId: string) {
    const nonce = this.openNonceByRecipient.get(
      recipientKey(channel, recipientId),
    );
    return nonce === undefined
      ? undefined
      : this.challengesByNonce.get(nonce);
  }

  async saveChallenge(challenge: SiweChallenge) {
    const key = recipientKey(challenge.channel, challenge.recipientId);
    const previous = this.openNonceByRecipient.get(key);
    if (previous !== undefined && previous !== challenge.nonce) {
      this.challengesByNonce.delete(previous);
    }
    this.challengesByNonce.set(challenge.nonce, challenge);
    this.openNonceByRecipient.set(key, challenge.nonce);
  }

  async consumeChallenge(nonce: string) {
    const challenge = this.challengesByNonce.get(nonce);
    this.challengesByNonce.delete(nonce);
    if (challenge !== undefined) {
      this.openNonceByRecipient.delete(
        recipientKey(challenge.channel, challenge.recipientId),
      );
    }
  }
}