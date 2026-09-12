import type {
    SiweChallenge,
    WalletBinding,
} from "../../../domain/identity/SiweChallenge.js";

export const IDENTITY_STORE_PORT = Symbol("IdentityStorePort");

export interface IdentityStorePort {
    findBinding(
        channel: string,
        recipientId: string,
    ): Promise<WalletBinding | undefined>;

    saveBinding(binding: WalletBinding): Promise<void>;

    findChallengeByNonce(nonce: string): Promise<SiweChallenge | undefined>;

    findOpenChallenge(
        channel: string,
        recipientId: string,
    ): Promise<SiweChallenge | undefined>;

    saveChallenge(challenge: SiweChallenge): Promise<void>;

    consumeChallenge(nonce: string): Promise<void>;
}