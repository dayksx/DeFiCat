import { generateSiweNonce } from "viem/siwe";
import type { TokenGeneratorPort } from "../../../app/ports/identity/TokenGeneratorPort.js";

export class ViemSiweNonceAdapter implements TokenGeneratorPort {
  nextSiweNonce(): string {
    return generateSiweNonce();
  }
}