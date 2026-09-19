# x402 + Telegram — péage avant le service (v1)

Guide d’implémentation, ancré sur `agents/` et `ui/`, **dans le même esprit**
que [SIWE_TELEGRAM.md](./SIWE_TELEGRAM.md).

Loi hexagonale : [HEXAGONAL.md](./HEXAGONAL.md). Sécurité paiement :
[SECURITY.md](./SECURITY.md) — **l’agent vérifie**, jamais la UI. Le LLM ne
peut pas sauter le péage.

> **Extension subname :** le catalogue comprend désormais aussi
> `ens.subname.create` à 0.01 USDC. Son flux suit exactement le SKU immédiat
> décrit ici ; voir [ENS_SUBNAMES.md](./ENS_SUBNAMES.md). Les extraits
> historiques ci-dessous restent centrés sur les deux SKU ENS v1 d’origine.

v1 **lean** : deux SKU, store in-memory, auto-exécution de l’intention payée,
pas de remboursement on-chain, pas de Mini App, pas de crédits prépayés.

---

## Décisions figées (cette v1)


| Fork              | Choix                                                   |
| ----------------- | ------------------------------------------------------- |
| Rail              | **x402** (`exact`, EIP-3009 USDC) + facilitator         |
| Chaîne USDC       | **Base Sepolia** `eip155:84532` (voir §2)               |
| Chaîne ENS / SIWE | `CHAIN_ID` (mainnet aujourd’hui) — inchangé             |
| Après paiement    | **auto-exécuter** l’intention (buy ou schedule)         |
| 0.1 USDC planifié | **à l’armement** du watch, pas au fire Temporal         |
| Payer             | EOA **déjà liée par SIWE** (même adresse, autre chaîne) |
| Treasury          | **même EOA que** `AGENT_PRIVATE_KEY`                    |
| Facilitator v1    | public `https://x402.org/facilitator`, **sans clé**     |


---



## Sommaire

1. [Pourquoi ce découpage](#1-pourquoi-ce-découpage)
2. [Overview — composants et interactions](#2-overview--composants-et-interactions)
3. [Hors scope v1](#3-hors-scope-v1)
4. [Prérequis](#4-prérequis)
5. [Étape — domaine](#5-étape--domaine)
6. [Étape — ports](#6-étape--ports)
7. [Étape — use cases](#7-étape--use-cases)
8. [Étape — adapters](#8-étape--adapters)
9. [Étape — HTTP driving adapter](#9-étape--http-driving-adapter)
10. [Étape — tools LangGraph + Telegram](#10-étape--tools-langgraph--telegram)
11. [Étape — UI](#11-étape--ui-pay) `/pay`
12. [Checklist de demo](#12-checklist-de-demo)
13. [Pièges](#13-pièges)

---



## 1. Pourquoi ce découpage

Aujourd’hui un `CONFIRM BUY …` déclenche tout de suite le commit ENS. Le
**service** (ETH de l’agent + Temporal) est gratuit. On veut deux **offres**
avant consommation :


| Offre    | SKU v1          | Prix        | Déclencheur actuel                                       |
| -------- | --------------- | ----------- | -------------------------------------------------------- |
| Immédiat | `ens.buy.now`   | **0.01 USDC** | `purchase_ens` `action=buy` après phrase de confirmation |
| Planifié | `ens.watch.arm` | **0.1 USDC**  | `schedule_ens` après phrase de confirmation              |


`lookup_ens`, `purchase_ens` `quote`, `list_ens_watches` restent **gratuits**.
Les swaps / DCA / limit orders n’existent pas encore : le catalogue a déjà
les deux `kind` pour ne pas recâbler le jour où ils arrivent.

Telegram ne parle pas HTTP 402. Exactement comme la SIWE : le bot **émet un
jeton**, la UI **signe le paiement**, l’agent **vérifie + settle**, puis
**rejoue l’intention** (contrairement au SIWE v1, qui ne rejouait pas le
premier message — ici le rejeu **est** le produit).

```text
  SIWE  = qui tu es   (chatId ↔ 0x, déjà en place)
  x402  = tu as payé  (receipt one-shot ↔ intention)
```

x402 n’est **pas** un middleware Nest sur tout le bot. C’est un **use case**
devant `PurchaseEnsName.execute` / `ScheduleEnsPurchase.execute`. Le modèle
voit un résultat d’outil `PAYMENT_REQUIRED` ; il n’a pas de levier pour
appeler le registrar sans receipt.

---



## 2. Overview — composants et interactions

```text
 Utilisateur Telegram (wallet déjà lié)
        │  CONFIRM BUY KIKOULOL.ETH FOR 1 YEAR
        ▼
 LangGraph → purchase_ens buy
        │  allowlist + phrase OK
        │  pas de PaymentReceipt pour cet intent ?
        ▼
 IssuePaymentSession
        │  catalogue : ens.buy.now = 0.01 USDC
        │  PaymentStore.saveSession(nonce, intent, payTo, expires)
        │  return PAYMENT_REQUIRED + {UI}/pay?token=
        ▼
 Telegram (via le LLM) : « Paye 0.01 USDC, puis je lance l’achat »
        │
        │  clic
        ▼
 ui/  GET  {AGENTS}/pay/x402?token=     → 402 + PAYMENT-REQUIRED
      sign EIP-3009 (USDC Base Sepolia, from = adresse SIWE)
      retry + PAYMENT-SIGNATURE
        ▼
 X402PayController → SettlePaymentAndFulfill
        │  FacilitatorPort.verify + settle
        │  consumeSession (one-shot)
        │  saveReceipt
        │  FulfillPaidIntent  →  PurchaseEnsName / ScheduleEnsPurchase
        ▼
 TelegramOutboundAdapter : « Payé. Achat en cours… » puis le reçu ENS
```

Le settle HTTP **ne doit pas** attendre les ~2 min du commit-reveal dans le
même request UI (timeout navigateur). Pattern :

1. `verify` + `settle` x402 (quelques secondes).
2. `202` / `200 { status: "paid", fulfilling: true }`.
3. `FulfillPaidIntent` en **fire-and-forget** (`void` + log + Telegram),
  déjà couvert par `TELEGRAM_HANDLER_TIMEOUT_MS` **côté bot**, pas côté UI.


| Pièce                        | Couche | Fichier cible                                      | Rôle                                                                |
| ---------------------------- | ------ | -------------------------------------------------- | ------------------------------------------------------------------- |
| `ServiceOffer` / catalogue   | domain | `domain/billing/ServiceCatalog.ts`                 | **prix seulement** : kind, sku, amount                              |
| `PaidIntent`                 | domain | `domain/billing/PaidIntent.ts`                     | quoi rejouer après settle (pas le texte Telegram)                   |
| `PaymentSession`             | domain | `domain/billing/PaymentSession.ts`                 | facture ouverte : nonce, payer, TTL, payTo, **référence** un intent |
| `PaymentPolicy`              | domain | `domain/billing/PaymentPolicy.ts`                  | issue, expire, assert payer = binding                               |
| `PaymentStorePort`           | app    | `app/ports/billing/PaymentStorePort.ts`            | sessions + receipts                                                 |
| `X402FacilitatorPort`        | app    | `app/ports/billing/X402FacilitatorPort.ts`         | verify / settle                                                     |
| `IssuePaymentSession`        | app    | `app/use-cases/Billing/IssuePaymentSession.ts`     | quote d’offre + jeton                                               |
| `SettlePaymentAndFulfill`    | app    | `app/use-cases/Billing/SettlePaymentAndFulfill.ts` | x402 puis intention                                                 |
| `FulfillPaidIntent`          | app    | `app/use-cases/Billing/FulfillPaidIntent.ts`       | dispatch buy / schedule                                             |
| `HttpX402FacilitatorAdapter` | infra  | `adapters/x402/HttpX402FacilitatorAdapter.ts`      | `POST {facilitator}/verify` et `/settle`                            |
| `InMemoryPaymentStore`       | infra  | `adapters/billing/InMemoryPaymentStore.ts`         | v1, meurt au restart                                                |
| `X402PayController`          | infra  | `adapters/http/X402PayController.ts`               | 402 + retry                                                         |
| Page `/pay`                  | ui     | `ui/src/app/pay/page.tsx`                          | wagmi Base Sepolia                                                  |


---



## 3. Hors scope v1

- Remboursement USDC si l’ENS fail après settle (Telegram : « payé, achat
raté, on te recrédite à la main »).
- Crédits / solde prépayé.
- Mini App Telegram, paiement in-chat.
- Swaps, limit orders, DCA (SKU réservés, pas de tools).
- Payer avec une autre adresse que le binding SIWE.
- ERC-1271, Permit2 (v1 = EIP-3009 USDC).
- Persistence Redis/SQL (restart = sessions impayées mortes, comme SIWE).
- x402 sur `lookup_ens` / quotes.
- Facilitator self-hosted.
- **Ethereum Sepolia** comme chaîne de paiement.

Pourquoi pas Ethereum Sepolia : le [CDP Facilitator](https://docs.cdp.coinbase.com/x402/network-support)
liste `eip155:84532` (Base Sepolia), pas `eip155:11155111`. « Testnet USDC »
en v1 = **USDC Base Sepolia**. L’EOA SIWE (mainnet) est la même clé ; il
faut du USDC **sur Base Sepolia**, pas sur Ethereum.

---



## 4. Prérequis

- SIWE v1 déjà en prod locale (`WalletBinding` présent).
- Facilitator public testnet `https://x402.org/facilitator`, sans clé pour la
démo. Le compte CDP servira plus tard pour un facilitator authentifié.
- USDC Base Sepolia sur l’EOA liée (faucet Circle / bridge testnet).
- Adresse **treasury** `X402_PAY_TO` = adresse publique dérivée de
`AGENT_PRIVATE_KEY`. Ne jamais exposer la clé privée dans la UI ou dans les
requirements x402.
- `pnpm` : paquet officiel x402 côté agent **et** UI (ne pas réinventer le
header `PAYMENT-REQUIRED`). Au câblage, pinner la version lue dans
`node_modules/@x402/*/package.json` — le wire format v1 vs v2 a bougé.

Env `agents/.env` :

```bash
# Paiement ≠ ENS. Base Sepolia pour x402 ; CHAIN_ID reste le mainnet ENS.
PAYMENT_CHAIN_ID=84532
X402_PAY_TO=0x...                  # même EOA que AGENT_PRIVATE_KEY, checksum
X402_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
# USDC Base Sepolia (vérifier sur le docs Circle / x402 network support
# au moment d’implémenter — l’adresse peut bouger).
X402_FACILITATOR_URL=https://x402.org/facilitator
X402_SESSION_TTL_MINUTES=15
```

UI : wagmi doit exposer **Base Sepolia** sur `/pay` (aujourd’hui `lib/wagmi.ts`
ne connaît que `NEXT_PUBLIC_CHAIN_ID` mainnet). Deux configs, ou `chains: [mainnet, baseSepolia]`
avec switch forcé sur `/pay`.

---



## 5. Étape — domaine

Trois fichiers distincts. `PaidIntent` **et** `PaymentSession` **ne vont pas dans** `ServiceCatalog.ts`**.**


| Fichier             | Contient                                   | Ne contient pas        |
| ------------------- | ------------------------------------------ | ---------------------- |
| `ServiceCatalog.ts` | SKU, offres, montants                      | chatId, nom ENS, nonce |
| `PaidIntent.ts`     | intention à rejouer, `skuFor`, `intentKey` | prix, TTL              |
| `PaymentSession.ts` | facture + reçu                             | table des prix         |
| `PaymentPolicy.ts`  | issue / expire / payer                     | I/O, env               |




### 5.1 Catalogue

`agents/src/domain/billing/ServiceCatalog.ts` **en entier** :

```ts
export type OfferKind = "immediate" | "scheduled";

export type ServiceSku = "ens.buy.now" | "ens.watch.arm";

export type ServiceOffer = {
  sku: ServiceSku;
  kind: OfferKind;
  amountAtomic: bigint; // 10_000n = 0.01 USDC (6 decimals)
  label: string;
};

const OFFERS: Record<ServiceSku, ServiceOffer> = {
  "ens.buy.now": {
    sku: "ens.buy.now",
    kind: "immediate",
    amountAtomic: 10_000n,
    label: "Buy an available .eth now",
  },
  "ens.watch.arm": {
    sku: "ens.watch.arm",
    kind: "scheduled",
    amountAtomic: 100_000n,
    label: "Watch a .eth and buy when it drops",
  },
};

export function offerFor(sku: ServiceSku): ServiceOffer {
  return OFFERS[sku];
}
```



### 5.2 Intention payée

`agents/src/domain/billing/PaidIntent.ts` **en entier** :

```ts
import type { ServiceSku } from "./ServiceCatalog.js";

export type PaidIntent =
  | { type: "ens.buy"; label: string; years: number }
  | { type: "ens.schedule"; label: string; years: number };

export function skuFor(intent: PaidIntent): ServiceSku {
  return intent.type === "ens.buy" ? "ens.buy.now" : "ens.watch.arm";
}

/** One receipt cannot pay a different name / duration. */
export function intentKey(intent: PaidIntent): string {
  return `${intent.type}:${intent.label}:${intent.years}`;
}
```



### 5.3 Session et reçu

`agents/src/domain/billing/PaymentSession.ts` **en entier** :

```ts
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
```



### 5.4 Politique

`agents/src/domain/billing/PaymentPolicy.ts` **en entier** :

```ts
import { DomainError } from "../errors/DomainError.js";
import { EthereumAddress } from "../identity/EthereumAddress.js";
import { skuFor, type PaidIntent } from "./PaidIntent.js";
import type { PaymentSession } from "./PaymentSession.js";
import { offerFor } from "./ServiceCatalog.js";

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
    const origin = input.uiOrigin.replace(/\/$/, "");
    const sku = skuFor(input.intent);
    const offer = offerFor(sku);
    return {
      nonce: input.nonce,
      channel: input.channel,
      recipientId: input.recipientId,
      payer: EthereumAddress.of(input.payer).value,
      sku,
      amountAtomic: offer.amountAtomic,
      payTo: EthereumAddress.of(input.payTo).value,
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
      throw new DomainError(
        "Payment link expired. Ask the bot for a new one.",
      );
    }
  }

  assertPayer(session: PaymentSession, recoveredPayer: string): void {
    const expected = EthereumAddress.of(session.payer).value;
    const actual = EthereumAddress.of(recoveredPayer).value;
    if (expected !== actual) {
      throw new DomainError(
        "Payer must be the Ethereum address linked to this Telegram chat.",
      );
    }
  }

  wallMessage(session: PaymentSession): string {
    const minutes = Math.round(this.ttlMs / 60_000);
    const usdc = formatUsdc(session.amountAtomic);
    const action =
      session.intent.type === "ens.buy"
        ? `buy ${session.intent.label}.eth`
        : `watch ${session.intent.label}.eth`;
    return [
      `Pay ${usdc} USDC to ${action}.`,
      `This link expires in ${minutes} minutes.`,
      "",
      session.uri,
    ].join("\n");
  }

  paidMessage(session: PaymentSession, txHash: string): string {
    const usdc = formatUsdc(session.amountAtomic);
    const explorer = explorerTxUrl(session.chainId, txHash);
    return [
      `Payment received (${usdc} USDC). Starting the job.`,
      "",
      "Receipt:",
      explorer ?? txHash,
    ].join("\n");
  }
}

function formatUsdc(amountAtomic: bigint): string {
  return (Number(amountAtomic) / 1_000_000).toString();
}

const EXPLORER_ORIGIN: Record<number, string> = {
  1: "https://etherscan.io",
  11155111: "https://sepolia.etherscan.io",
  8453: "https://basescan.org",
  84532: "https://sepolia.basescan.org",
};

export function explorerTxUrl(
  chainId: number,
  txHash: string,
): string | undefined {
  const origin = EXPLORER_ORIGIN[chainId];
  if (origin === undefined) return undefined;
  return `${origin}/tx/${txHash}`;
}
```

`agents/src/domain/billing/PaymentPolicy.spec.ts` **en entier** :

```ts
import { describe, expect, it } from "vitest";
import { DomainError } from "../errors/DomainError.js";
import {
  PAYMENT_SESSION_TTL_MS,
  PaymentPolicy,
} from "./PaymentPolicy.js";

describe("PaymentPolicy", () => {
  const policy = new PaymentPolicy();
  const issuedAt = new Date("2026-09-12T12:00:00.000Z");
  const session = policy.issue({
    nonce: "paynonce1",
    channel: "telegram",
    recipientId: "42",
    payer: "0x224b11F0747c7688a10aCC15F785354aA6493ED6",
    intent: { type: "ens.buy", label: "kikoulol", years: 1 },
    now: issuedAt,
    payTo: "0x224b11F0747c7688a10aCC15F785354aA6493ED6",
    chainId: 84532,
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    uiOrigin: "http://localhost:3001/",
  });

  it("prices an immediate buy at 0.01 USDC and sets the pay uri", () => {
    expect(session.sku).toBe("ens.buy.now");
    expect(session.amountAtomic).toBe(10_000n);
    expect(session.payer).toBe(
      "0x224b11f0747c7688a10acc15f785354aa6493ed6",
    );
    expect(session.uri).toBe("http://localhost:3001/pay?token=paynonce1");
    expect(session.expiresAt.getTime() - issuedAt.getTime()).toBe(
      PAYMENT_SESSION_TTL_MS,
    );
  });

  it("prices a watch arm at 0.1 USDC", () => {
    const watch = policy.issue({
      nonce: "paynonce2",
      channel: "telegram",
      recipientId: "42",
      payer: "0x224b11F0747c7688a10aCC15F785354aA6493ED6",
      intent: { type: "ens.schedule", label: "takenname", years: 1 },
      now: issuedAt,
      payTo: "0x224b11F0747c7688a10aCC15F785354aA6493ED6",
      chainId: 84532,
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      uiOrigin: "http://localhost:3001",
    });
    expect(watch.sku).toBe("ens.watch.arm");
    expect(watch.amountAtomic).toBe(100_000n);
  });

  it("is payable just before TTL and expired at TTL", () => {
    const almost = new Date(issuedAt.getTime() + PAYMENT_SESSION_TTL_MS - 1);
    const exact = new Date(issuedAt.getTime() + PAYMENT_SESSION_TTL_MS);
    expect(policy.isExpired(session, almost)).toBe(false);
    expect(() => policy.assertPayable(session, almost)).not.toThrow();
    expect(policy.isExpired(session, exact)).toBe(true);
    expect(() => policy.assertPayable(session, exact)).toThrow(DomainError);
  });

  it("accepts the linked payer case-insensitively and rejects another address", () => {
    expect(() =>
      policy.assertPayer(
        session,
        "0x224B11F0747C7688A10ACC15F785354AA6493ED6",
      ),
    ).not.toThrow();
    expect(() =>
      policy.assertPayer(
        session,
        "0x0000000000000000000000000000000000000001",
      ),
    ).toThrow(DomainError);
  });

  it("puts amount and uri in the wall copy", () => {
    expect(policy.wallMessage(session)).toContain("0.01 USDC");
    expect(policy.wallMessage(session)).toContain(session.uri);
  });
});
```

---



## 6. Étape — ports

Réutiliser `ClockPort` et `TokenGeneratorPort` (le nonce SIWE sert aussi de token de paiement).

### 6.1 Store

`agents/src/app/ports/billing/PaymentStorePort.ts` **en entier** :

```ts
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
```



### 6.2 Facilitator x402

Le port conserve nos résultats métier, mais utilise les types wire officiels
x402 v2 pour empêcher les dérives de schéma.

`agents/src/app/ports/billing/X402FacilitatorPort.ts` **en entier** :

```ts
import type {
  PaymentPayload,
  PaymentRequirements,
} from "@x402/core/types";

export const X402_FACILITATOR_PORT = Symbol("X402FacilitatorPort");

export type X402VerifyResult = {
  valid: boolean;
  payer?: string;
  reason?: string;
};

export type X402SettleResult = {
  txHash: string;
};

export interface X402FacilitatorPort {
  verify(input: {
    payload: PaymentPayload;
    requirements: PaymentRequirements;
  }): Promise<X402VerifyResult>;

  settle(input: {
    payload: PaymentPayload;
    requirements: PaymentRequirements;
  }): Promise<X402SettleResult>;
}
```



### 6.3 Config d’émission (valeur, pas un port)

`agents/src/app/use-cases/Billing/PaymentIssuance.ts` **en entier** :

```ts
export type PaymentIssuance = {
  payTo: string;
  chainId: number;
  asset: string;
  network: `${string}:${string}`;
  uiOrigin: string;
  extraName: string;
  extraVersion: string;
};
```

`agents/src/app/use-cases/Billing/PaymentError.ts` **en entier** :

```ts
import { DomainError } from "../../../domain/errors/DomainError.js";

export type PaymentErrorCode =
  | "NOT_LINKED"
  | "UNKNOWN_SESSION"
  | "INVALID_PAYMENT"
  | "SETTLEMENT_FAILED";

export class PaymentError extends DomainError {
  readonly code: PaymentErrorCode;
  readonly retryable: boolean;

  constructor(
    code: PaymentErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "PaymentError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}
```

---



## 7. Étape — use cases



### 7.1 Émettre une facture

`agents/src/app/use-cases/Billing/IssuePaymentSession.ts` **en entier** :

```ts
import { DomainError } from "../../../domain/errors/DomainError.js";
import type { PaidIntent } from "../../../domain/billing/PaidIntent.js";
import { intentKey } from "../../../domain/billing/PaidIntent.js";
import type { PaymentPolicy } from "../../../domain/billing/PaymentPolicy.js";
import type { ServiceOffer } from "../../../domain/billing/ServiceCatalog.js";
import { offerFor } from "../../../domain/billing/ServiceCatalog.js";
import { skuFor } from "../../../domain/billing/PaidIntent.js";
import type { ClockPort } from "../../ports/clock/ClockPort.js";
import type { IdentityStorePort } from "../../ports/identity/IdentityStorePort.js";
import type { TokenGeneratorPort } from "../../ports/identity/TokenGeneratorPort.js";
import type { PaymentStorePort } from "../../ports/billing/PaymentStorePort.js";
import { PaymentError } from "./PaymentError.js";
import type { PaymentIssuance } from "./PaymentIssuance.js";

export type IssuePaymentSessionInput = {
  channel: string;
  recipientId: string;
  intent: PaidIntent;
};

export type IssuePaymentSessionResult = {
  offer: ServiceOffer;
  payUrl: string;
  expiresAt: Date;
  nonce: string;
};

export class IssuePaymentSession {
  constructor(
    private readonly identities: IdentityStorePort,
    private readonly payments: PaymentStorePort,
    private readonly tokens: TokenGeneratorPort,
    private readonly clock: ClockPort,
    private readonly policy: PaymentPolicy,
    private readonly issuance: PaymentIssuance,
  ) {}

  public async execute(
    input: IssuePaymentSessionInput,
  ): Promise<IssuePaymentSessionResult> {
    const binding = await this.identities.findBinding(
      input.channel,
      input.recipientId,
    );
    if (binding === undefined) {
      throw new PaymentError(
        "NOT_LINKED",
        "Sign in with Ethereum before paying for a service",
      );
    }

    const now = this.clock.now();
    const key = intentKey(input.intent);
    const open = await this.payments.findOpenSession(
      input.channel,
      input.recipientId,
      key,
    );
    if (open !== undefined && !this.policy.isExpired(open, now)) {
      return {
        offer: offerFor(open.sku),
        payUrl: open.uri,
        expiresAt: open.expiresAt,
        nonce: open.nonce,
      };
    }

    const session = this.policy.issue({
      nonce: this.tokens.nextSiweNonce(),
      channel: input.channel,
      recipientId: input.recipientId,
      payer: binding.address,
      intent: input.intent,
      now,
      payTo: this.issuance.payTo,
      chainId: this.issuance.chainId,
      asset: this.issuance.asset,
      uiOrigin: this.issuance.uiOrigin,
    });
    await this.payments.saveSession(session);
    return {
      offer: offerFor(skuFor(input.intent)),
      payUrl: session.uri,
      expiresAt: session.expiresAt,
      nonce: session.nonce,
    };
  }
}
```



### 7.2 Requirements HTTP (GET → 402)

`agents/src/app/use-cases/Billing/GetX402Requirements.ts` **en entier** :

```ts
import { offerFor } from "../../../domain/billing/ServiceCatalog.js";
import type { PaymentPolicy } from "../../../domain/billing/PaymentPolicy.js";
import type { ClockPort } from "../../ports/clock/ClockPort.js";
import type { PaymentStorePort } from "../../ports/billing/PaymentStorePort.js";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { PaymentError } from "./PaymentError.js";
import type { PaymentIssuance } from "./PaymentIssuance.js";

export type X402RequirementsView = {
  paymentRequired: PaymentRequired;
  payer: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
};

export class GetX402Requirements {
  constructor(
    private readonly payments: PaymentStorePort,
    private readonly clock: ClockPort,
    private readonly policy: PaymentPolicy,
    private readonly issuance: PaymentIssuance,
  ) {}

  public async execute(token: string): Promise<X402RequirementsView> {
    const session = await this.payments.findSession(token);
    if (session === undefined) {
      throw new PaymentError(
        "UNKNOWN_SESSION",
        "Unknown or already used payment link",
      );
    }
    this.policy.assertPayable(session, this.clock.now());
    const offer = offerFor(session.sku);
    const accepted: PaymentRequirements = {
      scheme: "exact",
      network: this.issuance.network,
      amount: session.amountAtomic.toString(),
      payTo: session.payTo,
      asset: session.asset,
      maxTimeoutSeconds: 60,
      extra: {
        name: this.issuance.extraName,
        version: this.issuance.extraVersion,
        assetTransferMethod: "eip3009",
      },
    };
    return {
      paymentRequired: {
        x402Version: 2,
        resource: {
          url: session.uri,
          description: offer.label,
          mimeType: "application/json",
        },
        accepts: [accepted],
      },
      payer: session.payer,
      nonce: session.nonce,
      issuedAt: session.issuedAt.toISOString(),
      expirationTime: session.expiresAt.toISOString(),
    };
  }
}
```



### 7.3 Exécuter l’intention après paiement

`Logger` est une exception Nest en bordure de use case ici, comme les tools ENS — le métier reste le `switch` d’intent.

`agents/src/app/use-cases/Billing/FulfillPaidIntent.ts` **en entier** :

```ts
import { Logger } from "@nestjs/common";
import { formatEther } from "viem";
import type { PaidIntent } from "../../../domain/billing/PaidIntent.js";
import type { PaymentSession } from "../../../domain/billing/PaymentSession.js";
import type { OutboundMessagingPort } from "../../ports/messaging/OutboundMessagingPort.js";
import type { PurchaseEnsName } from "../PurchaseEnsName/PurchaseEnsName.js";
import type { ScheduleEnsPurchase } from "../EnsWatch/ScheduleEnsPurchase.js";

export class FulfillPaidIntent {
  private readonly logger = new Logger(FulfillPaidIntent.name);

  constructor(
    private readonly purchase: PurchaseEnsName,
    private readonly schedule: ScheduleEnsPurchase,
    private readonly messaging: OutboundMessagingPort,
  ) {}

  public async execute(
    intent: PaidIntent,
    session: PaymentSession,
  ): Promise<void> {
    try {
      const message = await this.run(intent, session);
      await this.messaging.send({
        channel: session.channel,
        recipientId: session.recipientId,
        message,
      });
    } catch (error) {
      this.logger.error(
        `Paid intent failed after settlement (${session.nonce})`,
        error instanceof Error ? error.stack : String(error),
      );
      await this.messaging.send({
        channel: session.channel,
        recipientId: session.recipientId,
        message:
          "Payment was received, but the job failed. The USDC is not refunded automatically. Tell DeFiCat support with your Telegram chat.",
      });
    }
  }

  private async run(
    intent: PaidIntent,
    session: PaymentSession,
  ): Promise<string> {
    if (intent.type === "ens.buy") {
      const receipt = await this.purchase.execute({
        label: intent.label,
        years: intent.years,
      });
      return [
        `Registered ${receipt.name}.`,
        `Owner: ${receipt.owner}`,
        `Tx: ${receipt.registrationTransactionHash}`,
        `Paid onchain: ${formatEther(BigInt(receipt.totalPaidWei))} ETH`,
      ].join("\n");
    }

    const result = await this.schedule.execute({
      label: intent.label,
      years: intent.years,
      chatId: session.recipientId,
    });
    if (result.kind === "buy-now") {
      return `${result.quote.name} is available within budget now. Use purchase_ens instead of a watch.`;
    }
    return `Watching ${result.watch.name}. It will be bought automatically once it drops within budget.`;
  }
}
```



### 7.4 Settle puis fulfill (sans await du buy ENS)

`agents/src/app/use-cases/Billing/SettlePaymentAndFulfill.ts` **en entier** :

```ts
import type { PaymentPolicy } from "../../../domain/billing/PaymentPolicy.js";
import type { ClockPort } from "../../ports/clock/ClockPort.js";
import type { PaymentStorePort } from "../../ports/billing/PaymentStorePort.js";
import type { PaymentPayload } from "@x402/core/types";
import type { X402FacilitatorPort } from "../../ports/billing/X402FacilitatorPort.js";
import type { OutboundMessagingPort } from "../../ports/messaging/OutboundMessagingPort.js";
import { PaymentError } from "./PaymentError.js";
import type { FulfillPaidIntent } from "./FulfillPaidIntent.js";
import type { GetX402Requirements } from "./GetX402Requirements.js";

export type SettlePaymentInput = {
  token: string;
  payload: PaymentPayload;
};

export class SettlePaymentAndFulfill {
  constructor(
    private readonly payments: PaymentStorePort,
    private readonly facilitator: X402FacilitatorPort,
    private readonly clock: ClockPort,
    private readonly policy: PaymentPolicy,
    private readonly messaging: OutboundMessagingPort,
    private readonly getRequirements: GetX402Requirements,
    private readonly fulfill: FulfillPaidIntent,
  ) {}

  public async execute(
    input: SettlePaymentInput,
  ): Promise<{ paid: true; fulfilling: true }> {
    const session = await this.payments.findSession(input.token);
    if (session === undefined) {
      throw new PaymentError(
        "UNKNOWN_SESSION",
        "Unknown or already used payment link",
      );
    }
    this.policy.assertPayable(session, this.clock.now());

    const view = await this.getRequirements.execute(input.token);
    const requirements = view.paymentRequired.accepts[0];
    if (requirements === undefined) {
      throw new PaymentError(
        "INVALID_PAYMENT",
        "No supported payment option is available",
      );
    }

    const verified = await this.facilitator.verify({
      payload: input.payload,
      requirements,
    });
    if (!verified.valid || verified.payer === undefined) {
      throw new PaymentError(
        "INVALID_PAYMENT",
        verified.reason ?? "Payment could not be verified",
      );
    }
    this.policy.assertPayer(session, verified.payer);

    let txHash: string;
    try {
      txHash = (await this.facilitator.settle({
        payload: input.payload,
        requirements,
      })).txHash;
    } catch (error) {
      throw new PaymentError(
        "SETTLEMENT_FAILED",
        "Payment settlement failed",
        { cause: error, retryable: true },
      );
    }

    const consumed = await this.payments.consumeSession(session.nonce);
    await this.payments.saveReceipt({
      nonce: consumed.nonce,
      channel: consumed.channel,
      recipientId: consumed.recipientId,
      payer: consumed.payer,
      sku: consumed.sku,
      amountAtomic: consumed.amountAtomic,
      intent: consumed.intent,
      settlementTxHash: txHash,
      paidAt: this.clock.now(),
    });

    await this.messaging.send({
      channel: consumed.channel,
      recipientId: consumed.recipientId,
      message: this.policy.paidMessage(consumed, txHash),
    });

    void this.fulfill.execute(consumed.intent, consumed);
    const explorerUrl = explorerTxUrl(consumed.chainId, txHash);
    return {
      paid: true,
      fulfilling: true,
      txHash,
      ...(explorerUrl !== undefined ? { explorerUrl } : {}),
    };
  }
}
```

---



## 8. Étape — adapters



### 8.1 Store in-memory

`agents/src/infrastructure/adapters/billing/InMemoryPaymentStore.ts` **en entier** :

```ts
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
```



### 8.2 Facilitator HTTP public (sans clé)

Le facilitator public expose `/verify` et `/settle` en x402 v2. Le contrat wire
est isolé dans cet adapter.

`agents/src/infrastructure/adapters/x402/HttpX402FacilitatorAdapter.ts` **en entier** :

```ts
import { PaymentError } from "../../../app/use-cases/Billing/PaymentError.js";
import type {
  X402FacilitatorPort,
  X402SettleResult,
  X402VerifyResult,
} from "../../../app/ports/billing/X402FacilitatorPort.js";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

export class HttpX402FacilitatorAdapter implements X402FacilitatorPort {
  constructor(private readonly baseUrl: string) {}

  async verify(input: {
    payload: PaymentPayload;
    requirements: PaymentRequirements;
  }): Promise<X402VerifyResult> {
    const body = await this.post("/verify", input);
    if (body.isValid !== true && body.valid !== true) {
      return {
        valid: false,
        reason:
          typeof body.invalidReason === "string"
            ? body.invalidReason
            : "Payment could not be verified",
      };
    }
    const payer =
      typeof body.payer === "string"
        ? body.payer
        : typeof body.invalidPayer === "string"
          ? undefined
          : undefined;
    return {
      valid: true,
      payer: typeof body.payer === "string" ? body.payer : undefined,
    };
  }

  async settle(input: {
    payload: PaymentPayload;
    requirements: PaymentRequirements;
  }): Promise<X402SettleResult> {
    const body = await this.post("/settle", input);
    const txHash =
      typeof body.transaction === "string"
        ? body.transaction
        : typeof body.txHash === "string"
          ? body.txHash
          : undefined;
    if (txHash === undefined) {
      throw new PaymentError(
        "SETTLEMENT_FAILED",
        "Facilitator did not return a transaction hash",
      );
    }
    return { txHash };
  }

  private async post(
    path: string,
    input: {
      payload: PaymentPayload;
      requirements: PaymentRequirements;
    },
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: input.payload,
        paymentRequirements: input.requirements,
      }),
    });
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new PaymentError(
        path === "/settle" ? "SETTLEMENT_FAILED" : "INVALID_PAYMENT",
        `Facilitator ${path} returned ${res.status}`,
      );
    }
    return json !== null && typeof json === "object"
      ? (json as Record<string, unknown>)
      : {};
  }
}
```

`SystemClockAdapter` et `ViemSiweNonceAdapter` existent déjà — ne pas les dupliquer.

---



## 9. Étape — HTTP driving adapter

Même process que Telegram (store mémoire). `GET` valide → **402**. `GET` mort → **401**. `POST settle` → 200 `{ paid, fulfilling }` **sans** attendre le commit ENS.

`agents/src/infrastructure/adapters/http/X402PayController.ts` **en entier** :

```ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { DomainError } from "../../../domain/errors/DomainError.js";
import { GetX402Requirements } from "../../../app/use-cases/Billing/GetX402Requirements.js";
import { SettlePaymentAndFulfill } from "../../../app/use-cases/Billing/SettlePaymentAndFulfill.js";

const tokenQuery = z.object({
  token: z.string().min(8).max(128),
});

const settleBody = z.object({
  token: z.string().min(8).max(128),
  payload: z.unknown(),
});

@Controller("pay/x402")
export class X402PayController {
  constructor(
    private readonly getRequirements: GetX402Requirements,
    private readonly settle: SettlePaymentAndFulfill,
  ) {}

  @Get()
  async requirements(@Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    const parsed = tokenQuery.safeParse(query);
    if (!parsed.success) {
      throw new HttpException("Invalid token", HttpStatus.BAD_REQUEST);
    }
    try {
      const view = await this.getRequirements.execute(parsed.data.token);
      res.status(HttpStatus.PAYMENT_REQUIRED);
      return view;
    } catch (err) {
      if (err instanceof DomainError) {
        throw new HttpException(err.message, HttpStatus.UNAUTHORIZED);
      }
      throw err;
    }
  }

  @Post("settle")
  @HttpCode(200)
  async settlePayment(@Body() body: unknown) {
    const parsed = settleBody.safeParse(body);
    if (!parsed.success) {
      throw new HttpException("Invalid body", HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.settle.execute({
        token: parsed.data.token,
        payload: parsed.data.payload,
      });
    } catch (err) {
      if (err instanceof DomainError) {
        throw new HttpException(err.message, HttpStatus.UNAUTHORIZED);
      }
      throw err;
    }
  }
}
```

Ajoute `X402PayController` dans `controllers: [...]` de `BotModule`, à côté de `SiweAuthController`.

Providers à ajouter dans `BotModule` (ne remplace pas le module entier : il câble déjà SIWE + ENS). Insère après les providers SIWE :

```ts
{ provide: PAYMENT_STORE_PORT, useClass: InMemoryPaymentStore },
{ provide: PaymentPolicy, useValue: new PaymentPolicy() },
{
  provide: PAYMENT_ISSUANCE,
  useFactory: (config: ConfigService): PaymentIssuance => ({
    payTo: config.getOrThrow<string>('X402_PAY_TO'),
    chainId: Number(config.getOrThrow<string>('PAYMENT_CHAIN_ID')),
    asset: config.getOrThrow<string>('X402_USDC_ADDRESS'),
    network: `eip155:${config.getOrThrow<string>('PAYMENT_CHAIN_ID')}`,
    uiOrigin: config.getOrThrow<string>('UI_ORIGIN'),
    extraName: 'USDC',
    extraVersion: '2',
  }),
  inject: [ConfigService],
},
{
  provide: X402_FACILITATOR_PORT,
  useFactory: (config: ConfigService) =>
    new HttpX402FacilitatorAdapter(
      config.getOrThrow<string>('X402_FACILITATOR_URL'),
    ),
  inject: [ConfigService],
},
{
  provide: IssuePaymentSession,
  useFactory: (
    identities: IdentityStorePort,
    payments: PaymentStorePort,
    tokens: TokenGeneratorPort,
    clock: ClockPort,
    policy: PaymentPolicy,
    issuance: PaymentIssuance,
  ) =>
    new IssuePaymentSession(
      identities, payments, tokens, clock, policy, issuance,
    ),
  inject: [
    IDENTITY_STORE_PORT,
    PAYMENT_STORE_PORT,
    TOKEN_GENERATOR_PORT,
    CLOCK_PORT,
    PaymentPolicy,
    PAYMENT_ISSUANCE,
  ],
},
{
  provide: GetX402Requirements,
  useFactory: (
    payments: PaymentStorePort,
    clock: ClockPort,
    policy: PaymentPolicy,
    issuance: PaymentIssuance,
  ) => new GetX402Requirements(payments, clock, policy, issuance),
  inject: [PAYMENT_STORE_PORT, CLOCK_PORT, PaymentPolicy, PAYMENT_ISSUANCE],
},
{
  provide: FulfillPaidIntent,
  useFactory: (
    purchase: PurchaseEnsName,
    schedule: ScheduleEnsPurchase,
    messaging: OutboundMessagingPort,
  ) => new FulfillPaidIntent(purchase, schedule, messaging),
  inject: [PurchaseEnsName, ScheduleEnsPurchase, MESSAGING_PORT],
},
{
  provide: SettlePaymentAndFulfill,
  useFactory: (
    payments: PaymentStorePort,
    facilitator: X402FacilitatorPort,
    clock: ClockPort,
    policy: PaymentPolicy,
    messaging: OutboundMessagingPort,
    getRequirements: GetX402Requirements,
    fulfill: FulfillPaidIntent,
  ) =>
    new SettlePaymentAndFulfill(
      payments, facilitator, clock, policy, messaging, getRequirements, fulfill,
    ),
  inject: [
    PAYMENT_STORE_PORT,
    X402_FACILITATOR_PORT,
    CLOCK_PORT,
    PaymentPolicy,
    MESSAGING_PORT,
    GetX402Requirements,
    FulfillPaidIntent,
  ],
},
```

`CONVERSATION_PORT` doit aussi recevoir `IssuePaymentSession` (voir §10).
`X402_PAY_TO` : adresse publique de `AGENT_PRIVATE_KEY` (checksum).

---



## 10. Étape — tools LangGraph

Après allowlist + phrase de confirmation, **ne plus** appeler `PurchaseEnsName.execute` / `ScheduleEnsPurchase.execute`. Appeler `IssuePaymentSession`.

Dans `createEnsPurchaseTool`, le `opts` gagne `issuePayment: IssuePaymentSession`. Remplace le bloc `buy` **après** `authorizeEnsPurchase` (le `quote` reste identique) :

```ts
      logger.log(`Invoicing ENS purchase for ${valid.name} (${valid.years}y)`);
      try {
        const invoice = await opts.issuePayment.execute({
          channel: "telegram",
          recipientId: telegramChatId(runtime.config.configurable?.thread_id)!,
          intent: {
            type: "ens.buy",
            label: valid.label,
            years: valid.years,
          },
        });
        return JSON.stringify({
          action: "buy",
          purchased: false,
          code: "PAYMENT_REQUIRED",
          sku: invoice.offer.sku,
          amountUsdc: (Number(invoice.offer.amountAtomic) / 1_000_000).toString(),
          payUrl: invoice.payUrl,
          expiresAt: invoice.expiresAt.toISOString(),
          guidance:
            "Tell the user to open payUrl and pay. Do not claim the name is bought. The agent will message Telegram after payment.",
        });
      } catch (error) {
        return failure(logger, "buy", valid.name, error);
      }
```

Ajoute `PAYMENT_REQUIRED` dans `GUIDANCE`.

Dans `createEnsWatchTools`, **avant** d’invoicer : `purchase.quote` (passe `PurchaseEnsName` dans `opts`). Si `available && withinBudget`, message buy-now **sans** paiement. Sinon `IssuePaymentSession` avec `{ type: "ens.schedule", ... }` (0.1 USDC).

`list_ens_watches` / `cancel_ens_watch` restent gratuits.

`LangGraphConversationAdapter.create` : ajoute `issuePayment: IssuePaymentSession` et transmets-le aux deux factories de tools.

Persona, une ligne :

> Paid actions return PAYMENT_REQUIRED with payUrl. Never invent a tx hash. Never ask CONFIRM again after they paid.

---



## 11. Étape — UI `/pay`

Installe le client officiel x402 v2 :

```bash
cd ui
pnpm add @x402/core @x402/evm
```


### 11.1 Wagmi : mainnet (SIWE) + Base Sepolia (x402)

Remplace `ui/lib/wagmi.ts` **en entier** :

```ts
import { http, createConfig } from "wagmi";
import { baseSepolia, mainnet, sepolia, type Chain } from "wagmi/chains";
import { injected } from "wagmi/connectors";

const ENS_CHAIN = {
  [mainnet.id]: mainnet,
  [sepolia.id]: sepolia,
} as const;

function ensChain(): Chain {
  const id = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "1");
  const chain = ENS_CHAIN[id as keyof typeof ENS_CHAIN];
  if (chain === undefined) {
    throw new Error(`Unsupported NEXT_PUBLIC_CHAIN_ID=${id}`);
  }
  return chain;
}

const ens = ensChain();

export const wagmiConfig = createConfig({
  chains: [ens, baseSepolia],
  connectors: [injected()],
  ssr: true,
  transports: {
    [ens.id]: http(),
    [baseSepolia.id]: http(),
  },
});
```

`ui/.env` :

```bash
NEXT_PUBLIC_AGENTS_URL=http://localhost:3000
NEXT_PUBLIC_CHAIN_ID=1
NEXT_PUBLIC_PAYMENT_CHAIN_ID=84532
```



### 11.2 Page de paiement

`ui/src/app/pay/page.tsx` **en entier** :

```tsx
"use client";

import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { ClientEvmSigner } from "@x402/evm";
import { getAddress } from "viem";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAccount, useConnect, useSwitchChain, useWalletClient } from "wagmi";
import { baseSepolia } from "wagmi/chains";

const AGENTS = process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3000";
const NEW_LINK = "please chat to DeFiCat to get a new payment link";

export default function PayPage() {
  return (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-zinc-400">Loading…</div>}>
      <PayForm />
    </Suspense>
  );
}

function PayForm() {
  const token = useSearchParams().get("token") ?? "";
  const { address, isConnected, chainId } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { connectAsync, connectors, isPending: connecting } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paid, setPaid] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => setMounted(true), []);

  async function onPay() {
    if (!token || !address || !walletClient || busy) return;
    setBusy(true);
    try {
      if (chainId !== baseSepolia.id) {
        await switchChainAsync({ chainId: baseSepolia.id });
      }
      const res = await fetch(
        `${AGENTS}/pay/x402?token=${encodeURIComponent(token)}`,
      );
      if (res.status === 401) {
        setStatus(`Sign-in / pay link timed out, ${NEW_LINK}`);
        return;
      }
      if (res.status !== 402) {
        setStatus(`DeFiCat could not quote that, ${NEW_LINK}`);
        return;
      }
      const requirements = await res.json();
      if (getAddress(address) !== getAddress(requirements.payer)) {
        setStatus("Reconnect the wallet linked to Telegram.");
        return;
      }
      const signer: ClientEvmSigner = {
        address: getAddress(address),
        signTypedData: async (typedData) =>
          walletClient.signTypedData({
            account: getAddress(address),
            ...typedData,
          } as Parameters<typeof walletClient.signTypedData>[0]),
      };
      const coreClient = new x402Client()
        .setSpendControls({ maxAmountPerPayment: "$0.10" })
        .register("eip155:84532", new ExactEvmScheme(signer));
      const payload = await new x402HTTPClient(coreClient).createPaymentPayload(
        requirements.paymentRequired as PaymentRequired,
      );
      const settle = await fetch(`${AGENTS}/pay/x402/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: requirements.nonce, payload }),
      });
      if (!settle.ok) {
        setStatus(`DeFiCat could not verify that, ${NEW_LINK}`);
        return;
      }
      setPaid(true);
      setStatus("Paid. Head back to Telegram — DeFiCat is running the job.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm text-center">
        <h1 className="mt-6 text-3xl font-black tracking-tight text-[#2AABEE]">DeFiCat</h1>
        <p className="mt-2 text-sm text-zinc-500">Pay USDC on Base Sepolia. No ENS gas from you.</p>
        {!token ? (
          <p className="mt-7 text-sm">This link has no token, {NEW_LINK}</p>
        ) : (
          <button
            type="button"
            disabled={mounted ? busy || paid : undefined}
            onClick={() => {
              if (!isConnected) {
                const c = connectors[0];
                if (c) void connectAsync({ connector: c });
                return;
              }
              void onPay();
            }}
            className="mt-8 h-12 w-full rounded-full bg-[#2AABEE] text-sm font-bold text-white"
          >
            {paid ? "Paid 😽" : connecting ? "Connecting…" : isConnected ? "Pay with USDC 🚀" : "Connect wallet 🔌"}
          </button>
        )}
        {status ? <p className="mt-6 text-sm text-zinc-600">{status}</p> : null}
      </div>
    </div>
  );
}
```

Le SDK produit le payload x402 v2 et la signature EIP-3009. Le plafond explicite
de 0.10 USD colle à l’offre planifiée (0.1 USDC) et reste sous le défaut SDK (1 USD).

---



## 12. Checklist de demo

1. `pnpm test src/domain/billing`.
2. Agent + UI, wallet SIWE lié, USDC Base Sepolia sur **la même** EOA.
3. Quote ENS — gratuit.
4. `CONFIRM BUY …` → lien `/pay?token=` — **pas** de commit ENS.
5. Payer → Telegram « Payment received » puis reçu d’enregistrement.
6. Restart agent avant pay → 401, nouveau CONFIRM.
7. `CONFIRM WATCH …` → 0.1 USDC → watch armé seulement après settle.
8. Autre wallet → `assertPayer`.

---



## 13. Pièges


| Symptôme              | Cause                         | Fix                            |
| --------------------- | ----------------------------- | ------------------------------ |
| 402 en boucle         | payload ≠ requirements        | reconstruire depuis le GET     |
| `unsupported network` | chainId 1 / 11155111          | `84532`                        |
| ENS buy sans payer    | tool appelle encore `execute` | uniquement `FulfillPaidIntent` |
| Double buy            | settle deux fois              | `consumeSession` avant fulfill |
| Session perdue        | `start:dev`                   | nouveau CONFIRM                |
| Timeout UI 30s        | fulfill await dans HTTP       | `void fulfill`                 |
| Quote payant          | middleware x402 global        | pas de middleware              |


---



## Ordre de build

1. Domaine + `PaymentPolicy.spec.ts` (déjà dans le repo).
2. Ports + `PaymentError` + `PaymentIssuance`.
3. `InMemoryPaymentStore` + `IssuePaymentSession`.
4. `GetX402Requirements` + controller GET 402 + page `/pay` (montant visible).
5. Facilitator + `SettlePaymentAndFulfill` (fulfill Telegram « paid »).
6. `FulfillPaidIntent` → ENS.
7. Couper l’exécution directe dans les tools.
8. Checklist.

