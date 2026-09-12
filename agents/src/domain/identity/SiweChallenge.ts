export type SiweChallenge = {
    nonce: string;
    channel: string;
    recipientId: string;
    issuedAt: Date;
    expiresAt: Date;
    uri: string;
  };
  
  export type WalletBinding = {
    channel: string;
    recipientId: string;
    address: string;
    boundAt: Date;
  };
  
  export function recipientKey(channel: string, recipientId: string): string {
    return `${channel}:${recipientId}`;
  }