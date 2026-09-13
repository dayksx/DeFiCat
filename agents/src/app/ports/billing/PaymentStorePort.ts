import type {
    PaymentReceipt,
    PaymentSession,
  } from "../../../domain/billing/PaymentSession.js";
  
  export const PAYMENT_STORE_PORT = Symbol("PaymentStorePort");
  
  export interface PaymentStorePort {
    findSession(nonce: string): Promise<PaymentSession | undefined>;
  
    findOpenSession(
      channel: string,
      recipientId: string,
      intentKey: string,
    ): Promise<PaymentSession | undefined>;
  
    saveSession(session: PaymentSession): Promise<void>;
  
    /** One-shot. Throws DomainError if the nonce is unknown. */
    consumeSession(nonce: string): Promise<PaymentSession>;
  
    saveReceipt(receipt: PaymentReceipt): Promise<void>;
  
    findReceipt(
      channel: string,
      recipientId: string,
      intentKey: string,
    ): Promise<PaymentReceipt | undefined>;
  }