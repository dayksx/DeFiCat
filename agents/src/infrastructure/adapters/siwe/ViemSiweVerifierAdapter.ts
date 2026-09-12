import {
    getAddress,
    verifyMessage,
    type Hex,
  } from "viem";
  import { createSiweMessage } from "viem/siwe";
  import { DomainError } from "../../../domain/errors/DomainError.js";
  import type {
    SiweVerifierPort,
    SiweVerifyInput,
  } from "../../../app/ports/identity/SiweVerifierPort.js";
  
  export class ViemSiweVerifierAdapter implements SiweVerifierPort {
    async verify(input: SiweVerifyInput): Promise<{ address: string }> {
      let checksum: string;
      try {
        checksum = getAddress(input.address);
      } catch {
        throw new DomainError("Invalid Ethereum address");
      }
  
      const expected = createSiweMessage({
        address: checksum as `0x${string}`,
        chainId: input.chainId,
        domain: input.domain,
        nonce: input.nonce,
        uri: input.uri,
        version: "1",
        statement: input.statement,
        issuedAt: input.issuedAt,
        expirationTime: input.expirationTime,
      });
  
      if (input.message !== expected) {
        throw new DomainError("SIWE message does not match the issued challenge");
      }
  
      let valid = false;
      try {
        valid = await verifyMessage({
          address: checksum as `0x${string}`,
          message: input.message,
          signature: input.signature as Hex,
        });
      } catch (err) {
        throw new DomainError("Invalid SIWE signature", { cause: err });
      }
      if (!valid) {
        throw new DomainError("Invalid SIWE signature");
      }
      if (input.now.getTime() >= input.expirationTime.getTime()) {
        throw new DomainError("SIWE challenge expired. Ask the bot for a new link.");
      }
      return { address: checksum };
    }
  }