import { DomainError } from '../errors/DomainError.js';
import { EthereumAddress } from '../identity/EthereumAddress.js';
import { skuFor, type PaidIntent } from './PaidIntent.js';
import type { PaymentSession } from './PaymentSession.js';
import { offerFor } from './ServiceCatalog.js';

/** 15 minutes — TTL de demo / tests. */
export const PAYMENT_SESSION_TTL_MS = 15 * 60 * 1000;

/** Driving channel for other agents. Any wallet may pay; no SIWE bind. */
export const A2A_CHANNEL = 'a2a';

/** Placeholder payer on an A2A invoice, replaced by the verified x402 payer. */
export const A2A_OPEN_PAYER = '0x0000000000000000000000000000000000000000';

export class PaymentPolicy {
  constructor(public readonly ttlMs: number = PAYMENT_SESSION_TTL_MS) {}

  issue(input: {
    nonce: string;
    channel: string;
    recipientId: string;
    payer: string;
    intent: PaidIntent;
    now: Date;
    payTo: string;
    chainId: number;
    asset: string;
    uiOrigin: string;
    /** Overrides the Telegram UI pay link (A2A resources use the skill URL). */
    uri?: string;
  }): PaymentSession {
    const origin = input.uiOrigin.replace(/\/$/, '');
    const sku = skuFor(input.intent);
    const offer = offerFor(sku);
    const payer = EthereumAddress.of(input.payer).value;
    const payTo = EthereumAddress.of(input.payTo).value;
    return {
      nonce: input.nonce,
      channel: input.channel,
      recipientId: input.recipientId,
      payer,
      sku,
      amountAtomic: offer.amountAtomic,
      payTo,
      chainId: input.chainId,
      asset: input.asset,
      intent: input.intent,
      issuedAt: input.now,
      expiresAt: new Date(input.now.getTime() + this.ttlMs),
      uri: input.uri ?? `${origin}/pay?token=${input.nonce}`,
    };
  }

  isExpired(session: PaymentSession, now: Date): boolean {
    return now.getTime() >= session.expiresAt.getTime();
  }

  assertPayable(session: PaymentSession, now: Date): void {
    if (this.isExpired(session, now)) {
      throw new DomainError('Payment link expired. Ask the bot for a new one.');
    }
  }

  assertPayer(session: PaymentSession, recoveredPayer: string): void {
    if (session.channel === A2A_CHANNEL) {
      EthereumAddress.of(recoveredPayer);
      return;
    }
    const expected = EthereumAddress.of(session.payer).value;
    const actual = EthereumAddress.of(recoveredPayer).value;
    if (expected !== actual) {
      throw new DomainError(
        'Payer must be the Ethereum address linked to this Telegram chat.',
      );
    }
  }

  wallMessage(session: PaymentSession): string {
    const minutes = Math.round(this.ttlMs / 60_000);
    const usdc = formatUsdc(session.amountAtomic);
    const action =
      session.intent.type === 'ens.buy'
        ? `buy ${session.intent.label}.eth`
        : session.intent.type === 'ens.subname'
          ? `create ${session.intent.name}`
          : `watch ${session.intent.label}.eth`;
    return [
      `Pay ${usdc} USDC to ${action}.`,
      `This link expires in ${minutes} minutes.`,
      '',
      session.uri,
    ].join('\n');
  }

  paidMessage(session: PaymentSession, txHash: string): string {
    const usdc = formatUsdc(session.amountAtomic);
    const explorer = explorerTxUrl(session.chainId, txHash);
    return [
      `Payment received (${usdc} USDC). Starting the job.`,
      '',
      'Receipt:',
      explorer ?? txHash,
    ].join('\n');
  }
}

/** Known EVM explorers used for payment receipts. Unknown chains fall back to the hash. */
const EXPLORER_ORIGIN: Record<number, string> = {
  1: 'https://etherscan.io',
  11155111: 'https://sepolia.etherscan.io',
  8453: 'https://basescan.org',
  84532: 'https://sepolia.basescan.org',
};

export function explorerTxUrl(
  chainId: number,
  txHash: string,
): string | undefined {
  const origin = EXPLORER_ORIGIN[chainId];
  if (origin === undefined) return undefined;
  return `${origin}/tx/${txHash}`;
}

const ENS_APP_ORIGIN: Record<number, string> = {
  1: 'https://app.ens.domains',
  11155111: 'https://sepolia.app.ens.domains',
};

/** Manager page for a newly minted name or subname. */
export function ensAppUrl(chainId: number, name: string): string {
  const origin = ENS_APP_ORIGIN[chainId] ?? 'https://app.ens.domains';
  return `${origin}/${name}`;
}

function formatUsdc(amountAtomic: bigint): string {
  return (Number(amountAtomic) / 1_000_000).toString();
}
