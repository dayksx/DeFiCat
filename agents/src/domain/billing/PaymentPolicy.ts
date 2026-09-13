import { DomainError } from '../errors/DomainError.js';
import { EthereumAddress } from '../identity/EthereumAddress.js';
import { skuFor, type PaidIntent } from './PaidIntent.js';
import type { PaymentSession } from './PaymentSession.js';
import { offerFor } from './ServiceCatalog.js';

/** 15 minutes — TTL de demo / tests. */
export const PAYMENT_SESSION_TTL_MS = 15 * 60 * 1000;

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
  }): PaymentSession {
    const origin = input.uiOrigin.replace(/\/$/, '');
    const sku = skuFor(input.intent);
    const offer = offerFor(sku);
    const payer = EthereumAddress.of(input.payer).value;
    const payTo = EthereumAddress.of(input.payTo).value;
    // Paying yourself moves no value but still needs the full balance, so the
    // token reverts on balance instead of naming the real problem: the linked
    // wallet is the agent treasury.
    if (payer === payTo) {
      throw new DomainError(
        'The linked wallet is the agent treasury. Sign in with a different wallet to pay.',
      );
    }
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
      uri: `${origin}/pay?token=${input.nonce}`,
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
        : `watch ${session.intent.label}.eth`;
    return [
      `Pay ${usdc} USDC to ${action}.`,
      `This link expires in ${minutes} minutes.`,
      '',
      session.uri,
    ].join('\n');
  }

  paidMessage(session: PaymentSession): string {
    const usdc = formatUsdc(session.amountAtomic);
    return `Payment received (${usdc} USDC). Starting the job.`;
  }
}

function formatUsdc(amountAtomic: bigint): string {
  return (Number(amountAtomic) / 1_000_000).toString();
}
