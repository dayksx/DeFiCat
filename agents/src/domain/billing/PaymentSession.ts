import type { PaidIntent } from "./PaidIntent.js";
import type { ServiceSku } from "./ServiceCatalog.js";

export type PaymentSession = {
  nonce: string;
  channel: string;
  recipientId: string;
  payer: string;
  sku: ServiceSku;
  amountAtomic: bigint;
  payTo: string;
  chainId: number;
  asset: string;
  intent: PaidIntent;
  issuedAt: Date;
  expiresAt: Date;
  uri: string;
};

export type PaymentReceipt = {
  nonce: string;
  channel: string;
  recipientId: string;
  payer: string;
  sku: ServiceSku;
  amountAtomic: bigint;
  intent: PaidIntent;
  settlementTxHash: string;
  paidAt: Date;
};
