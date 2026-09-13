import { DomainError } from "../../../domain/errors/DomainError.js";
import { intentKey } from "../../../domain/billing/PaidIntent.js";
import type {
  PaymentReceipt,
  PaymentSession,
} from "../../../domain/billing/PaymentSession.js";
import type { PaymentStorePort } from "../../../app/ports/billing/PaymentStorePort.js";

function openKey(
  channel: string,
  recipientId: string,
  key: string,
): string {
  return `${channel}:${recipientId}:${key}`;
}

export class InMemoryPaymentStore implements PaymentStorePort {
  private readonly sessionsByNonce = new Map<string, PaymentSession>();
  private readonly openByIntent = new Map<string, string>();
  private readonly receipts = new Map<string, PaymentReceipt>();

  async findSession(nonce: string) {
    return this.sessionsByNonce.get(nonce);
  }

  async findOpenSession(
    channel: string,
    recipientId: string,
    key: string,
  ) {
    const nonce = this.openByIntent.get(openKey(channel, recipientId, key));
    return nonce === undefined
      ? undefined
      : this.sessionsByNonce.get(nonce);
  }

  async saveSession(session: PaymentSession) {
    const key = openKey(
      session.channel,
      session.recipientId,
      intentKey(session.intent),
    );
    const previous = this.openByIntent.get(key);
    if (previous !== undefined && previous !== session.nonce) {
      this.sessionsByNonce.delete(previous);
    }
    this.sessionsByNonce.set(session.nonce, session);
    this.openByIntent.set(key, session.nonce);
  }

  async consumeSession(nonce: string) {
    const session = this.sessionsByNonce.get(nonce);
    if (session === undefined) {
      throw new DomainError("Unknown or already used payment link");
    }
    this.sessionsByNonce.delete(nonce);
    this.openByIntent.delete(
      openKey(session.channel, session.recipientId, intentKey(session.intent)),
    );
    return session;
  }

  async saveReceipt(receipt: PaymentReceipt) {
    this.receipts.set(
      openKey(receipt.channel, receipt.recipientId, intentKey(receipt.intent)),
      receipt,
    );
  }

  async findReceipt(
    channel: string,
    recipientId: string,
    key: string,
  ) {
    return this.receipts.get(openKey(channel, recipientId, key));
  }
}