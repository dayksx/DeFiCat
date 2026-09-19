# SIWE + Telegram — mur d’enceinte (v1)

Guide d’implémentation, ancré sur `agents/` et le scaffold `ui/`.

v1 **lean** : pas de rejeu du premier message, pas de Mini App, pas de JWT
produit, pas de base SQL. Un lien Telegram → la UI signe → **l’agent** vérifie
la SIWE et lie `chatId` ↔ adresse. TTL du challenge : **15 minutes**.

Loi hexagonale : [HEXAGONAL.md](./HEXAGONAL.md). Sécurité SIWE :
[SECURITY.md](./SECURITY.md) (nonce serveur, one-shot, `domain` + `chainId`).
Le package `siwe` n’est **pas** ajouté : `viem` est déjà dans `agents/` et
expose `createSiweMessage` / `generateSiweNonce` / `parseSiweMessage`.

---



## Sommaire

1. [Overview — composants et interactions](#1-overview--composants-et-interactions)
2. [Hors scope v1](#2-hors-scope-v1)
3. [Prérequis](#3-prérequis)
4. [Étape — domaine](#4-étape--domaine)
5. [Étape — ports](#5-étape--ports)
6. [Étape — use cases](#6-étape--use-cases)
7. [Étape — adapters in-memory + horloge + SIWE](#7-étape--adapters-in-memory--horloge--siwe)
8. [Étape — HTTP driving adapter](#8-étape--http-driving-adapter)
9. [Étape — câbler BotModule](#9-étape--câbler-botmodule)
10. [Étape — UI Next (deep link)](#10-étape--ui-next-deep-link)
11. [Checklist de demo](#11-checklist-de-demo)
12. [Pièges](#12-pièges)

---



## 1. Overview — composants et interactions

Telegram ne sait pas signer. L’identité Ethereum vit **dans l’agent**, pas dans
le bot token ni dans un cookie Next.

```text
 Utilisateur Telegram
        │  1. n’importe quel texte
        ▼
 TelegramInboundAdapter
        │  HandleIncomingMessage.execute
        ▼
 ┌──────────────────────────────────────────┐
 │  pas de WalletBinding ?                  │
 │    TokenGenerator → SiweBindPolicy.issue │
 │    IdentityStore.saveChallenge           │
 │    MessagingPort : lien UI (TTL 15 min)  │
 │    return          ← LLM jamais appelé   │
 │                                          │
 │  binding présent ?                       │
 │    ConversationPort.reply (LangGraph)    │
 └──────────────────────────────────────────┘
        │
        │  2. clic deep link
        ▼
 ui/  GET  {AGENTS}/auth/siwe/challenge?token=
        │  connect wallet + personal_sign
        │  3. POST {AGENTS}/auth/siwe/verify
        ▼
 SiweAuthController → CompleteSiweBind
        │  reconstruit le message canonique
        │  ViemSiweVerifierAdapter (ecrecover)
        │  consumeChallenge (one-shot)
        │  saveBinding(chat ↔ 0x…)
        ▼
 TelegramOutboundAdapter : « Wallet 0x… is linked »
```


| Pièce                     | Couche   | Fichier cible                                   | Rôle                                       |
| ------------------------- | -------- | ----------------------------------------------- | ------------------------------------------ |
| `EthereumAddress`         | domain   | `agents/src/domain/identity/EthereumAddress.ts` | checksum syntaxique, pas de viem           |
| `SiweBindPolicy`          | domain   | `…/identity/SiweBindPolicy.ts`                  | TTL 15 min, copies Telegram, issue/assert  |
| `ClockPort`               | app port | `agents/src/app/ports/clock/ClockPort.ts`       | `now()` injectable (tests gelés)           |
| `TokenGeneratorPort`      | app port | `…/ports/identity/TokenGeneratorPort.ts`        | nonce EIP-4361                             |
| `IdentityStorePort`       | app port | `…/ports/identity/IdentityStorePort.ts`         | challenges + bindings                      |
| `SiweVerifierPort`        | app port | `…/ports/identity/SiweVerifierPort.ts`          | vérif signature, **sans** type viem        |
| `HandleIncomingMessage`   | use case | déjà là — **à modifier**                        | mur avant LangGraph                        |
| `GetSiweChallenge`        | use case | `…/use-cases/SiweAuth/GetSiweChallenge.ts`      | GET public du challenge                    |
| `CompleteSiweBind`        | use case | `…/use-cases/SiweAuth/CompleteSiweBind.ts`      | POST verify + notify Telegram              |
| `InMemoryIdentityStore`   | driven   | `…/adapters/identity/InMemoryIdentityStore.ts`  | perdu au restart (ok demo)                 |
| `ViemSiweNonceAdapter`    | driven   | `…/adapters/siwe/ViemSiweNonceAdapter.ts`       | `generateSiweNonce`                        |
| `ViemSiweVerifierAdapter` | driven   | `…/adapters/siwe/ViemSiweVerifierAdapter.ts`    | message canonique + `verifyMessage`        |
| `SystemClockAdapter`      | driven   | `…/adapters/clock/SystemClockAdapter.ts`        | `new Date()` uniquement ici                |
| `SiweAuthController`      | driving  | `…/adapters/http/SiweAuthController.ts`         | Zod → `execute`                            |
| Page `/siwe`              | ui       | `ui/src/app/siwe/page.tsx`                      | signe, n’a **pas** le droit de « valider » |


**Source de vérité du message SIWE : l’agent.** La UI reçoit les champs
(`nonce`, `domain`, `uri`, `chainId`, `statement`, `issuedAt`,
`expirationTime`), y ajoute **seulement** l’adresse du wallet, reconstruit le
même string avec `createSiweMessage`, signe. Au POST, l’agent reconstruit **le
même string** et refuse si `message !== expected`. Une UI maligne ne peut pas
changer le `statement` ni le `uri`.

Le `nonce` SIWE **est** le token du deep link (`generateSiweNonce`). Un token
encore valide est **réutilisé** si l’utilisateur renvoie un message avant
expiration (sinon le lien déjà ouvert dans le navigateur meurt).

**Mur d’enceinte :** aucun texte n’est exempté. `/start` comme « gm » : pas de
binding → lien, pas de LLM. v1 ne rejoue pas le premier texte : après le bind,
l’utilisateur envoie **un nouveau** message.

```text
IdentityStore (mémoire processus bot)

  challengesByNonce        nonce → SiweChallenge
  openNonceByRecipient     "telegram:123" → nonce   (réutilisation TTL)
  bindingsByRecipient      "telegram:123" → WalletBinding
```

Le worker Temporal **n’a pas** ce store. Les notifs d’achat ENS sortent toujours
via `TelegramOutboundAdapter` ; l’auth ne concerne que le process `bot.ts`.

---



## 2. Hors scope v1

- Rejouer le message d’avant-auth
- Mini App Telegram / `initData`
- Persistance Redis/SQL (un restart du bot = tout le monde se re-lie)
- Smart-contract wallets (ERC-1271) — EOA + `personal_sign` seulement
- `/logout`, rotation, allowlist d’adresses
- x402 (ça s’enchaîne **après**, identité ≠ paiement)
- Remplacer `ENS_BUYER_ALLOWED_TELEGRAM_CHAT_IDS` (tu peux le faire plus tard
avec le binding)

---



## 3. Prérequis

Dans `agents/` tu as déjà Nest, Telegraf, viem, Zod, Vitest. **Aucune**
dépendance npm nouvelle côté agent.

```bash
cd agents
# rien à pnpm add
```

Env à ajouter dans `agents/.env` et `agents/.env.example` :

```bash
# Origine de la UI (CORS + URI SIWE). Port 3001, le bot reste sur 3000.
UI_ORIGIN=http://localhost:3001

# EIP-4361 « domain » = host[:port], SANS schéma.
SIWE_DOMAIN=localhost:3001

# Chaîne sur laquelle le wallet doit être pour signer (MetaMask network).
# 1 = Ethereum mainnet. Pour une demo Sepolia : 11155111 des deux côtés.
SIWE_CHAIN_ID=1

SIWE_STATEMENT=Sign in to DeFiCat and link this wallet to your Telegram chat.
```

`UI_ORIGIN` et `SIWE_DOMAIN` doivent décrire **le même host** que celui dans la
barre d’adresse au moment du sign (sinon MetaMask / la vérif refusent).

---



## 4. Étape — domaine



### 4.1 `EthereumAddress`

`agents/src/domain/identity/EthereumAddress.ts` :

```ts
import { DomainError } from "../errors/DomainError.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export class EthereumAddress {
  private constructor(public readonly value: string) {}

  static of(raw: string): EthereumAddress {
    const v = raw.trim();
    if (!ADDRESS.test(v)) {
      throw new DomainError("Invalid Ethereum address");
    }
    return new EthereumAddress(v.toLowerCase());
  }

  toString(): string {
    return this.value;
  }
}
```

`agents/src/domain/identity/EthereumAddress.spec.ts` :

```ts
import { describe, expect, it } from "vitest";
import { EthereumAddress } from "./EthereumAddress.js";
import { DomainError } from "../errors/DomainError.js";

describe("EthereumAddress", () => {
  it("lowercases a valid address", () => {
    const a = EthereumAddress.of(
      "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e",
    );
    expect(a.value).toBe("0xa0cf798816d4b9b9866b5330eea46a18382f251e");
  });

  it("rejects truncated input", () => {
    expect(() => EthereumAddress.of("0xabc")).toThrow(DomainError);
  });
});
```

Pas de `getAddress` viem ici : le domain ne connaît pas viem. Le checksum EIP-55
est vérifié **dans** l’adapter SIWE au moment de `createSiweMessage`.

### 4.2 Challenge + binding (types)

`agents/src/domain/identity/SiweChallenge.ts` :

```ts
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
```



### 4.3 `SiweBindPolicy`

`agents/src/domain/identity/SiweBindPolicy.ts` :

```ts
import { DomainError } from "../errors/DomainError.js";
import type { SiweChallenge } from "./SiweChallenge.js";

/** 15 minutes — TTL de demo / tests. */
export const SIWE_BIND_TTL_MS = 15 * 60 * 1000;

export class SiweBindPolicy {
  constructor(public readonly ttlMs: number = SIWE_BIND_TTL_MS) {}

  issue(input: {
    nonce: string;
    channel: string;
    recipientId: string;
    now: Date;
    uiOrigin: string;
  }): SiweChallenge {
    const origin = input.uiOrigin.replace(/\/$/, "");
    return {
      nonce: input.nonce,
      channel: input.channel,
      recipientId: input.recipientId,
      issuedAt: input.now,
      expiresAt: new Date(input.now.getTime() + this.ttlMs),
      uri: `${origin}/siwe?token=${input.nonce}`,
    };
  }

  isExpired(challenge: SiweChallenge, now: Date): boolean {
    return now.getTime() >= challenge.expiresAt.getTime();
  }

  assertActive(challenge: SiweChallenge, now: Date): void {
    if (this.isExpired(challenge, now)) {
      throw new DomainError("SIWE challenge expired. Ask the bot for a new link.");
    }
  }

  wallMessage(challenge: SiweChallenge): string {
    const minutes = Math.round(this.ttlMs / 60_000);
    return [
      "Sign in with Ethereum to talk to DeFiCat.",
      `This link expires in ${minutes} minutes.`,
      "",
      challenge.uri,
    ].join("\n");
  }

  linkedMessage(address: string): string {
    return `Wallet ${address} is linked. Send a message to continue.`;
  }
}
```

`agents/src/domain/identity/SiweBindPolicy.spec.ts` :

```ts
import { describe, expect, it } from "vitest";
import { DomainError } from "../errors/DomainError.js";
import { SIWE_BIND_TTL_MS, SiweBindPolicy } from "./SiweBindPolicy.js";

describe("SiweBindPolicy", () => {
  const policy = new SiweBindPolicy();
  const issuedAt = new Date("2026-09-12T12:00:00.000Z");

  const challenge = policy.issue({
    nonce: "abc12345defg6789",
    channel: "telegram",
    recipientId: "42",
    now: issuedAt,
    uiOrigin: "http://localhost:3001/",
  });

  it("sets uri and 15-minute expiry", () => {
    expect(challenge.uri).toBe(
      "http://localhost:3001/siwe?token=abc12345defg6789",
    );
    expect(challenge.expiresAt.getTime() - issuedAt.getTime()).toBe(
      SIWE_BIND_TTL_MS,
    );
  });

  it("is active just before TTL and expired at TTL", () => {
    const almost = new Date(issuedAt.getTime() + SIWE_BIND_TTL_MS - 1);
    const exact = new Date(issuedAt.getTime() + SIWE_BIND_TTL_MS);
    expect(policy.isExpired(challenge, almost)).toBe(false);
    expect(() => policy.assertActive(challenge, almost)).not.toThrow();
    expect(policy.isExpired(challenge, exact)).toBe(true);
    expect(() => policy.assertActive(challenge, exact)).toThrow(DomainError);
  });

  it("puts the uri in the wall copy", () => {
    expect(policy.wallMessage(challenge)).toContain(challenge.uri);
    expect(policy.wallMessage(challenge)).toContain("15 minutes");
  });
});
```

Vérifie le domain seul :

```bash
cd agents
pnpm test src/domain/identity
```

---



## 5. Étape — ports

Aucun SDK dans ces fichiers. Token `Symbol` à côté de l’interface, comme
`ConversationPort`.

### 5.1 Horloge

`agents/src/app/ports/clock/ClockPort.ts` :

```ts
export const CLOCK_PORT = Symbol("ClockPort");

export interface ClockPort {
  now(): Date;
}
```



### 5.2 Nonce

`agents/src/app/ports/identity/TokenGeneratorPort.ts` :

```ts
export const TOKEN_GENERATOR_PORT = Symbol("TokenGeneratorPort");

export interface TokenGeneratorPort {
  nextSiweNonce(): string;
}
```



### 5.3 Store

`agents/src/app/ports/identity/IdentityStorePort.ts` :

```ts
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
```



### 5.4 Vérif SIWE

`agents/src/app/ports/identity/SiweVerifierPort.ts` :

```ts
export const SIWE_VERIFIER_PORT = Symbol("SiweVerifierPort");

export type SiweVerifyInput = {
  message: string;
  signature: string;
  address: string;
  nonce: string;
  domain: string;
  uri: string;
  chainId: number;
  statement: string;
  issuedAt: Date;
  expirationTime: Date;
  now: Date;
};

export interface SiweVerifierPort {
  /**
   * Reconstruit le message canonique, exige `message === expected`,
   * puis vérifie la signature EIP-191. Retourne l’adresse checksummée.
   */
  verify(input: SiweVerifyInput): Promise<{ address: string }>;
}
```



### 5.5 Config d’émission (valeur, pas un port)

`agents/src/app/use-cases/SiweAuth/SiweIssuance.ts` :

```ts
export type SiweIssuance = {
  domain: string;
  chainId: number;
  statement: string;
  uiOrigin: string;
};
```

Injectée depuis `bootstrap/` (env). Le use case ne lit pas `process.env`.

---



## 6. Étape — use cases



### 6.1 Mur : `HandleIncomingMessage`

Remplace `agents/src/app/use-cases/HandleIncomingMessage/HandleIncomingMessage.ts`
**en entier** :

```ts
import type { Agent } from "../../../domain/agent/Agent.js";
import type { SiweBindPolicy } from "../../../domain/identity/SiweBindPolicy.js";
import type { ClockPort } from "../../ports/clock/ClockPort.js";
import type { ConversationPort } from "../../ports/conversation/ConversationPort.js";
import type { IdentityStorePort } from "../../ports/identity/IdentityStorePort.js";
import type { TokenGeneratorPort } from "../../ports/identity/TokenGeneratorPort.js";
import type {
  InboundMessage,
  OutboundMessagingPort,
} from "../../ports/messaging/OutboundMessagingPort.js";
import type { SiweIssuance } from "../SiweAuth/SiweIssuance.js";

export class HandleIncomingMessage {
  constructor(
    private readonly conversation: ConversationPort,
    private readonly messaging: OutboundMessagingPort,
    private readonly agent: Agent,
    private readonly identities: IdentityStorePort,
    private readonly tokens: TokenGeneratorPort,
    private readonly clock: ClockPort,
    private readonly policy: SiweBindPolicy,
    private readonly issuance: SiweIssuance,
  ) {}

  public async execute(inbound: InboundMessage): Promise<void> {
    this.agent.assertCanHandle(inbound.channel);

    const binding = await this.identities.findBinding(
      inbound.channel,
      inbound.recipientId,
    );
    if (binding === undefined) {
      await this.messaging.send({
        channel: inbound.channel,
        recipientId: inbound.recipientId,
        message: this.policy.wallMessage(
          await this.ensureChallenge(inbound),
        ),
      });
      return;
    }

    const threadId = `${this.agent.id}:${inbound.channel}:${inbound.recipientId}`;
    const reply = await this.conversation.reply(threadId, inbound.message);
    await this.messaging.send({
      channel: inbound.channel,
      recipientId: inbound.recipientId,
      message: reply,
    });
  }

  private async ensureChallenge(inbound: InboundMessage) {
    const now = this.clock.now();
    const open = await this.identities.findOpenChallenge(
      inbound.channel,
      inbound.recipientId,
    );
    if (open !== undefined && !this.policy.isExpired(open, now)) {
      return open;
    }
    const challenge = this.policy.issue({
      nonce: this.tokens.nextSiweNonce(),
      channel: inbound.channel,
      recipientId: inbound.recipientId,
      now,
      uiOrigin: this.issuance.uiOrigin,
    });
    await this.identities.saveChallenge(challenge);
    return challenge;
  }
}
```

Remplace `HandleIncomingMessage.spec.ts` **en entier** :

```ts
import { describe, expect, it } from "vitest";
import { HandleIncomingMessage } from "./HandleIncomingMessage.js";
import { Agent } from "../../../domain/agent/Agent.js";
import { AgentId } from "../../../domain/agent/AgentId.js";
import { SiweBindPolicy } from "../../../domain/identity/SiweBindPolicy.js";
import type { ClockPort } from "../../ports/clock/ClockPort.js";
import type { ConversationPort } from "../../ports/conversation/ConversationPort.js";
import type { IdentityStorePort } from "../../ports/identity/IdentityStorePort.js";
import type { TokenGeneratorPort } from "../../ports/identity/TokenGeneratorPort.js";
import type {
  OutboundMessagingPort,
  OutboundMessage,
} from "../../ports/messaging/OutboundMessagingPort.js";
import type {
  SiweChallenge,
  WalletBinding,
} from "../../../domain/identity/SiweChallenge.js";
import { recipientKey } from "../../../domain/identity/SiweChallenge.js";
import type { SiweIssuance } from "../SiweAuth/SiweIssuance.js";

class FakeConversation implements ConversationPort {
  calls = 0;
  lastThreadId: string | undefined;

  async reply(threadId: string, message: string): Promise<string> {
    this.calls += 1;
    this.lastThreadId = threadId;
    return `ok:${message}`;
  }
}

class FakeMessaging implements OutboundMessagingPort {
  sent: OutboundMessage[] = [];
  async send(m: OutboundMessage): Promise<void> {
    this.sent.push(m);
  }
}

class FakeClock implements ClockPort {
  constructor(private t: Date) {}
  now(): Date {
    return this.t;
  }
}

class FakeTokens implements TokenGeneratorPort {
  constructor(private readonly nonce: string) {}
  nextSiweNonce(): string {
    return this.nonce;
  }
}

class MemoryIdentities implements IdentityStorePort {
  bindings = new Map<string, WalletBinding>();
  challenges = new Map<string, SiweChallenge>();
  open = new Map<string, string>();

  async findBinding(channel: string, recipientId: string) {
    return this.bindings.get(recipientKey(channel, recipientId));
  }
  async saveBinding(binding: WalletBinding) {
    this.bindings.set(
      recipientKey(binding.channel, binding.recipientId),
      binding,
    );
  }
  async findChallengeByNonce(nonce: string) {
    return this.challenges.get(nonce);
  }
  async findOpenChallenge(channel: string, recipientId: string) {
    const nonce = this.open.get(recipientKey(channel, recipientId));
    return nonce === undefined ? undefined : this.challenges.get(nonce);
  }
  async saveChallenge(challenge: SiweChallenge) {
    this.challenges.set(challenge.nonce, challenge);
    this.open.set(
      recipientKey(challenge.channel, challenge.recipientId),
      challenge.nonce,
    );
  }
  async consumeChallenge(nonce: string) {
    const c = this.challenges.get(nonce);
    this.challenges.delete(nonce);
    if (c !== undefined) {
      this.open.delete(recipientKey(c.channel, c.recipientId));
    }
  }
}

const issuance: SiweIssuance = {
  domain: "localhost:3001",
  chainId: 1,
  statement: "Sign in to DeFiCat",
  uiOrigin: "http://localhost:3001",
};

function setup(opts?: { bound?: boolean; now?: Date }) {
  const now = opts?.now ?? new Date("2026-09-12T12:00:00.000Z");
  const conversation = new FakeConversation();
  const messaging = new FakeMessaging();
  const identities = new MemoryIdentities();
  if (opts?.bound) {
    identities.bindings.set("telegram:999", {
      channel: "telegram",
      recipientId: "999",
      address: "0xabc",
      boundAt: now,
    });
  }
  const uc = new HandleIncomingMessage(
    conversation,
    messaging,
    new Agent(AgentId.of("defichat"), "p"),
    identities,
    new FakeTokens("nonce-1"),
    new FakeClock(now),
    new SiweBindPolicy(),
    issuance,
  );
  return { uc, conversation, messaging, identities };
}

describe("HandleIncomingMessage", () => {
  it("sends the SIWE wall and does not call the LLM when unbound", async () => {
    const { uc, conversation, messaging } = setup();

    await uc.execute({
      channel: "telegram",
      recipientId: "999",
      message: "gm",
    });

    expect(conversation.calls).toBe(0);
    expect(messaging.sent[0]?.message).toContain(
      "http://localhost:3001/siwe?token=nonce-1",
    );
  });

  it("reuses a still-valid challenge instead of minting a new nonce", async () => {
    const { uc, identities, messaging } = setup();
    await uc.execute({
      channel: "telegram",
      recipientId: "999",
      message: "gm",
    });
    await uc.execute({
      channel: "telegram",
      recipientId: "999",
      message: "hello again",
    });

    expect(identities.challenges.size).toBe(1);
    expect(messaging.sent[1]?.message).toContain("token=nonce-1");
  });

  it("replies via the LLM when a wallet is already linked", async () => {
    const { uc, conversation, messaging } = setup({ bound: true });

    await uc.execute({
      channel: "telegram",
      recipientId: "999",
      message: "gm",
    });

    expect(conversation.lastThreadId).toBe("defichat:telegram:999");
    expect(messaging.sent[0]?.message).toBe("ok:gm");
  });
});
```

```bash
pnpm test src/app/use-cases/HandleIncomingMessage
```



### 6.2 `GetSiweChallenge`

`agents/src/app/use-cases/SiweAuth/GetSiweChallenge.ts` :

```ts
import { DomainError } from "../../../domain/errors/DomainError.js";
import type { SiweBindPolicy } from "../../../domain/identity/SiweBindPolicy.js";
import type { ClockPort } from "../../ports/clock/ClockPort.js";
import type { IdentityStorePort } from "../../ports/identity/IdentityStorePort.js";
import type { SiweIssuance } from "./SiweIssuance.js";

export type SiweChallengeView = {
  nonce: string;
  domain: string;
  uri: string;
  chainId: number;
  statement: string;
  version: "1";
  issuedAt: string;
  expirationTime: string;
};

export class GetSiweChallenge {
  constructor(
    private readonly identities: IdentityStorePort,
    private readonly clock: ClockPort,
    private readonly policy: SiweBindPolicy,
    private readonly issuance: SiweIssuance,
  ) {}

  public async execute(token: string): Promise<SiweChallengeView> {
    const challenge = await this.identities.findChallengeByNonce(token);
    if (challenge === undefined) {
      throw new DomainError("Unknown or already used SIWE challenge");
    }
    this.policy.assertActive(challenge, this.clock.now());
    return {
      nonce: challenge.nonce,
      domain: this.issuance.domain,
      uri: challenge.uri,
      chainId: this.issuance.chainId,
      statement: this.issuance.statement,
      version: "1",
      issuedAt: challenge.issuedAt.toISOString(),
      expirationTime: challenge.expiresAt.toISOString(),
    };
  }
}
```

`agents/src/app/use-cases/SiweAuth/GetSiweChallenge.spec.ts` :

```ts
import { describe, expect, it } from "vitest";
import { DomainError } from "../../../domain/errors/DomainError.js";
import { SiweBindPolicy } from "../../../domain/identity/SiweBindPolicy.js";
import type { ClockPort } from "../../ports/clock/ClockPort.js";
import type { IdentityStorePort } from "../../ports/identity/IdentityStorePort.js";
import type {
  SiweChallenge,
  WalletBinding,
} from "../../../domain/identity/SiweChallenge.js";
import { GetSiweChallenge } from "./GetSiweChallenge.js";
import type { SiweIssuance } from "./SiweIssuance.js";

class FakeClock implements ClockPort {
  constructor(public t: Date) {}
  now(): Date {
    return this.t;
  }
}

class EmptyStore implements IdentityStorePort {
  async findBinding(): Promise<WalletBinding | undefined> {
    return undefined;
  }
  async saveBinding(): Promise<void> {}
  async findChallengeByNonce(
    nonce: string,
  ): Promise<SiweChallenge | undefined> {
    if (nonce !== "alive") return undefined;
    return {
      nonce: "alive",
      channel: "telegram",
      recipientId: "1",
      issuedAt: new Date("2026-09-12T12:00:00.000Z"),
      expiresAt: new Date("2026-09-12T12:15:00.000Z"),
      uri: "http://localhost:3001/siwe?token=alive",
    };
  }
  async findOpenChallenge(): Promise<SiweChallenge | undefined> {
    return undefined;
  }
  async saveChallenge(): Promise<void> {}
  async consumeChallenge(): Promise<void> {}
}

const issuance: SiweIssuance = {
  domain: "localhost:3001",
  chainId: 1,
  statement: "Sign in to DeFiCat",
  uiOrigin: "http://localhost:3001",
};

describe("GetSiweChallenge", () => {
  it("returns issuance fields for an active challenge", async () => {
    const uc = new GetSiweChallenge(
      new EmptyStore(),
      new FakeClock(new Date("2026-09-12T12:05:00.000Z")),
      new SiweBindPolicy(),
      issuance,
    );
    const view = await uc.execute("alive");
    expect(view.nonce).toBe("alive");
    expect(view.domain).toBe("localhost:3001");
    expect(view.issuedAt).toBe("2026-09-12T12:00:00.000Z");
  });

  it("rejects an unknown token", async () => {
    const uc = new GetSiweChallenge(
      new EmptyStore(),
      new FakeClock(new Date("2026-09-12T12:05:00.000Z")),
      new SiweBindPolicy(),
      issuance,
    );
    await expect(uc.execute("nope")).rejects.toBeInstanceOf(DomainError);
  });

  it("rejects an expired challenge", async () => {
    const uc = new GetSiweChallenge(
      new EmptyStore(),
      new FakeClock(new Date("2026-09-12T12:15:00.000Z")),
      new SiweBindPolicy(),
      issuance,
    );
    await expect(uc.execute("alive")).rejects.toBeInstanceOf(DomainError);
  });
});
```



### 6.3 `CompleteSiweBind`

`agents/src/app/use-cases/SiweAuth/CompleteSiweBind.ts` :

```ts
import { DomainError } from "../../../domain/errors/DomainError.js";
import { EthereumAddress } from "../../../domain/identity/EthereumAddress.js";
import type { SiweBindPolicy } from "../../../domain/identity/SiweBindPolicy.js";
import type { ClockPort } from "../../ports/clock/ClockPort.js";
import type { IdentityStorePort } from "../../ports/identity/IdentityStorePort.js";
import type { SiweVerifierPort } from "../../ports/identity/SiweVerifierPort.js";
import type { OutboundMessagingPort } from "../../ports/messaging/OutboundMessagingPort.js";
import type { SiweIssuance } from "./SiweIssuance.js";

export type CompleteSiweBindInput = {
  token: string;
  address: string;
  message: string;
  signature: string;
};

export class CompleteSiweBind {
  constructor(
    private readonly identities: IdentityStorePort,
    private readonly verifier: SiweVerifierPort,
    private readonly messaging: OutboundMessagingPort,
    private readonly clock: ClockPort,
    private readonly policy: SiweBindPolicy,
    private readonly issuance: SiweIssuance,
  ) {}

  public async execute(
    input: CompleteSiweBindInput,
  ): Promise<{ address: string }> {
    const challenge = await this.identities.findChallengeByNonce(input.token);
    if (challenge === undefined) {
      throw new DomainError("Unknown or already used SIWE challenge");
    }
    const now = this.clock.now();
    this.policy.assertActive(challenge, now);

    const address = EthereumAddress.of(input.address);
    const verified = await this.verifier.verify({
      message: input.message,
      signature: input.signature,
      address: address.value,
      nonce: challenge.nonce,
      domain: this.issuance.domain,
      uri: challenge.uri,
      chainId: this.issuance.chainId,
      statement: this.issuance.statement,
      issuedAt: challenge.issuedAt,
      expirationTime: challenge.expiresAt,
      now,
    });

    await this.identities.consumeChallenge(challenge.nonce);
    await this.identities.saveBinding({
      channel: challenge.channel,
      recipientId: challenge.recipientId,
      address: verified.address.toLowerCase(),
      boundAt: now,
    });
    await this.messaging.send({
      channel: challenge.channel,
      recipientId: challenge.recipientId,
      message: this.policy.linkedMessage(verified.address),
    });
    return { address: verified.address };
  }
}
```

`agents/src/app/use-cases/SiweAuth/CompleteSiweBind.spec.ts` :

```ts
import { describe, expect, it } from "vitest";
import { DomainError } from "../../../domain/errors/DomainError.js";
import { SiweBindPolicy } from "../../../domain/identity/SiweBindPolicy.js";
import type { ClockPort } from "../../ports/clock/ClockPort.js";
import type { IdentityStorePort } from "../../ports/identity/IdentityStorePort.js";
import type { SiweVerifierPort } from "../../ports/identity/SiweVerifierPort.js";
import type {
  OutboundMessage,
  OutboundMessagingPort,
} from "../../ports/messaging/OutboundMessagingPort.js";
import type {
  SiweChallenge,
  WalletBinding,
} from "../../../domain/identity/SiweChallenge.js";
import { recipientKey } from "../../../domain/identity/SiweChallenge.js";
import { CompleteSiweBind } from "./CompleteSiweBind.js";
import type { SiweIssuance } from "./SiweIssuance.js";

const ADDR = "0xa0cf798816d4b9b9866b5330eea46a18382f251e";
const issuedAt = new Date("2026-09-12T12:00:00.000Z");

class FakeClock implements ClockPort {
  now(): Date {
    return new Date("2026-09-12T12:05:00.000Z");
  }
}

class FakeMessaging implements OutboundMessagingPort {
  sent: OutboundMessage[] = [];
  async send(m: OutboundMessage): Promise<void> {
    this.sent.push(m);
  }
}

class FakeVerifier implements SiweVerifierPort {
  lastMessage: string | undefined;
  async verify(input: { message: string; address: string }) {
    this.lastMessage = input.message;
    return { address: "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e" };
  }
}

class Store implements IdentityStorePort {
  challenge: SiweChallenge | undefined = {
    nonce: "n1",
    channel: "telegram",
    recipientId: "42",
    issuedAt,
    expiresAt: new Date("2026-09-12T12:15:00.000Z"),
    uri: "http://localhost:3001/siwe?token=n1",
  };
  bindings: WalletBinding[] = [];

  async findBinding() {
    return undefined;
  }
  async saveBinding(b: WalletBinding) {
    this.bindings.push(b);
  }
  async findChallengeByNonce(nonce: string) {
    return this.challenge?.nonce === nonce ? this.challenge : undefined;
  }
  async findOpenChallenge() {
    return this.challenge;
  }
  async saveChallenge() {}
  async consumeChallenge() {
    this.challenge = undefined;
  }
}

const issuance: SiweIssuance = {
  domain: "localhost:3001",
  chainId: 1,
  statement: "Sign in to DeFiCat",
  uiOrigin: "http://localhost:3001",
};

function uc(store = new Store(), verifier = new FakeVerifier()) {
  const messaging = new FakeMessaging();
  return {
    messaging,
    verifier,
    store,
    complete: new CompleteSiweBind(
      store,
      verifier,
      messaging,
      new FakeClock(),
      new SiweBindPolicy(),
      issuance,
    ),
  };
}

describe("CompleteSiweBind", () => {
  it("binds the chat, consumes the nonce, and notifies Telegram", async () => {
    const { complete, store, messaging } = uc();
    const result = await complete.execute({
      token: "n1",
      address: ADDR,
      message: "siwe",
      signature: "0xsig",
    });
    expect(result.address).toBe("0xA0Cf798816D4b9b9866b5330EEa46a18382f251e");
    expect(store.challenge).toBeUndefined();
    expect(store.bindings[0]?.recipientId).toBe("42");
    expect(store.bindings[0]?.address).toBe(ADDR);
    expect(messaging.sent[0]?.recipientId).toBe("42");
    expect(messaging.sent[0]?.message).toContain("0xA0Cf");
  });

  it("rejects a second verify on the same token", async () => {
    const { complete } = uc();
    await complete.execute({
      token: "n1",
      address: ADDR,
      message: "siwe",
      signature: "0xsig",
    });
    await expect(
      complete.execute({
        token: "n1",
        address: ADDR,
        message: "siwe",
        signature: "0xsig",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
```

```bash
pnpm test src/app/use-cases/SiweAuth
```

---



## 7. Étape — adapters in-memory + horloge + SIWE



### 7.1 Horloge système

Implémente `ClockPort` → même dossier que les autres adapters
(`infrastructure/adapters/`), pas `infrastructure/clock/`.
`infrastructure/time/` existe déjà pour un **helper**
(`createIsoZoneFormatter`) qui n’implémente aucun port ; ne pas mélanger.

`agents/src/infrastructure/adapters/clock/SystemClockAdapter.ts` :

```ts
import type { ClockPort } from "../../../app/ports/clock/ClockPort.js";

export class SystemClockAdapter implements ClockPort {
  now(): Date {
    return new Date();
  }
}
```



### 7.2 Nonce viem

`agents/src/infrastructure/adapters/siwe/ViemSiweNonceAdapter.ts` :

```ts
import { generateSiweNonce } from "viem/siwe";
import type { TokenGeneratorPort } from "../../../app/ports/identity/TokenGeneratorPort.js";

export class ViemSiweNonceAdapter implements TokenGeneratorPort {
  nextSiweNonce(): string {
    return generateSiweNonce();
  }
}
```



### 7.3 Store mémoire

`agents/src/infrastructure/adapters/identity/InMemoryIdentityStore.ts` :

```ts
import type { IdentityStorePort } from "../../../app/ports/identity/IdentityStorePort.js";
import type {
  SiweChallenge,
  WalletBinding,
} from "../../../domain/identity/SiweChallenge.js";
import { recipientKey } from "../../../domain/identity/SiweChallenge.js";

export class InMemoryIdentityStore implements IdentityStorePort {
  private readonly challengesByNonce = new Map<string, SiweChallenge>();
  private readonly openNonceByRecipient = new Map<string, string>();
  private readonly bindingsByRecipient = new Map<string, WalletBinding>();

  async findBinding(channel: string, recipientId: string) {
    return this.bindingsByRecipient.get(recipientKey(channel, recipientId));
  }

  async saveBinding(binding: WalletBinding) {
    this.bindingsByRecipient.set(
      recipientKey(binding.channel, binding.recipientId),
      binding,
    );
  }

  async findChallengeByNonce(nonce: string) {
    return this.challengesByNonce.get(nonce);
  }

  async findOpenChallenge(channel: string, recipientId: string) {
    const nonce = this.openNonceByRecipient.get(
      recipientKey(channel, recipientId),
    );
    return nonce === undefined
      ? undefined
      : this.challengesByNonce.get(nonce);
  }

  async saveChallenge(challenge: SiweChallenge) {
    const key = recipientKey(challenge.channel, challenge.recipientId);
    const previous = this.openNonceByRecipient.get(key);
    if (previous !== undefined && previous !== challenge.nonce) {
      this.challengesByNonce.delete(previous);
    }
    this.challengesByNonce.set(challenge.nonce, challenge);
    this.openNonceByRecipient.set(key, challenge.nonce);
  }

  async consumeChallenge(nonce: string) {
    const challenge = this.challengesByNonce.get(nonce);
    this.challengesByNonce.delete(nonce);
    if (challenge !== undefined) {
      this.openNonceByRecipient.delete(
        recipientKey(challenge.channel, challenge.recipientId),
      );
    }
  }
}
```



### 7.4 Vérif viem (EOA)

L’adapter **reconstruit** le message avec les mêmes champs que la UI, compare
les strings, puis `verifyMessage` (EIP-191, **sans RPC** — v1 EOA only).

`agents/src/infrastructure/adapters/siwe/ViemSiweVerifierAdapter.ts` :

```ts
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
```

`agents/src/infrastructure/adapters/siwe/ViemSiweVerifierAdapter.spec.ts` :

```ts
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { DomainError } from "../../../domain/errors/DomainError.js";
import { ViemSiweVerifierAdapter } from "./ViemSiweVerifierAdapter.js";

const issuedAt = new Date("2026-09-12T12:00:00.000Z");
const expirationTime = new Date("2026-09-12T12:15:00.000Z");
const now = new Date("2026-09-12T12:05:00.000Z");

describe("ViemSiweVerifierAdapter", () => {
  it("accepts a signature over the canonical message", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const fields = {
      address: account.address,
      chainId: 1,
      domain: "localhost:3001",
      nonce: "abc12345defg6789",
      uri: "http://localhost:3001/siwe?token=abc12345defg6789",
      version: "1" as const,
      statement: "Sign in to DeFiCat",
      issuedAt,
      expirationTime,
    };
    const message = createSiweMessage(fields);
    const signature = await account.signMessage({ message });
    const adapter = new ViemSiweVerifierAdapter();

    const result = await adapter.verify({
      ...fields,
      message,
      signature,
      now,
    });
    expect(result.address).toBe(account.address);
  });

  it("rejects a tampered statement", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const message = createSiweMessage({
      address: account.address,
      chainId: 1,
      domain: "localhost:3001",
      nonce: "abc12345defg6789",
      uri: "http://localhost:3001/siwe?token=abc12345defg6789",
      version: "1",
      statement: "I am an attacker",
      issuedAt,
      expirationTime,
    });
    const signature = await account.signMessage({ message });
    const adapter = new ViemSiweVerifierAdapter();

    await expect(
      adapter.verify({
        message,
        signature,
        address: account.address,
        nonce: "abc12345defg6789",
        domain: "localhost:3001",
        uri: "http://localhost:3001/siwe?token=abc12345defg6789",
        chainId: 1,
        statement: "Sign in to DeFiCat",
        issuedAt,
        expirationTime,
        now,
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
```

```bash
pnpm test src/infrastructure/adapters/siwe src/domain/identity src/app/use-cases/SiweAuth src/app/use-cases/HandleIncomingMessage
```

---



## 8. Étape — HTTP driving adapter

Le controller parse (Zod), appelle `execute`, mappe `DomainError` → 401.
**Aucun** `if` métier (TTL, binding) ici.

`agents/src/infrastructure/adapters/http/SiweAuthController.ts` :

```ts
import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { DomainError } from "../../../domain/errors/DomainError.js";
import { CompleteSiweBind } from "../../../app/use-cases/SiweAuth/CompleteSiweBind.js";
import { GetSiweChallenge } from "../../../app/use-cases/SiweAuth/GetSiweChallenge.js";

const tokenQuery = z.object({
  token: z.string().min(8).max(128),
});

const verifyBody = z.object({
  token: z.string().min(8).max(128),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  message: z.string().min(1).max(4096),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(2000),
});

@Controller("auth/siwe")
export class SiweAuthController {
  constructor(
    private readonly getChallenge: GetSiweChallenge,
    private readonly complete: CompleteSiweBind,
  ) {}

  @Get("challenge")
  async challenge(@Query() query: unknown) {
    const parsed = tokenQuery.safeParse(query);
    if (!parsed.success) {
      throw new HttpException("Invalid token", HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.getChallenge.execute(parsed.data.token);
    } catch (err) {
      if (err instanceof DomainError) {
        throw new HttpException(err.message, HttpStatus.UNAUTHORIZED);
      }
      throw err;
    }
  }

  @Post("verify")
  async verify(@Body() body: unknown) {
    const parsed = verifyBody.safeParse(body);
    if (!parsed.success) {
      throw new HttpException("Invalid body", HttpStatus.BAD_REQUEST);
    }
    try {
      const result = await this.complete.execute(parsed.data);
      return { ok: true, address: result.address };
    } catch (err) {
      if (err instanceof DomainError) {
        throw new HttpException(err.message, HttpStatus.UNAUTHORIZED);
      }
      throw err;
    }
  }
}
```

Ne logue **jamais** `message` ni `signature`.

---



## 9. Étape — câbler `BotModule`



### 9.1 CORS dans `bot.ts`

Remplace `agents/src/bootstrap/bot.ts` :

```ts
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { BotModule } from "./BotModule.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(BotModule);
  const config = app.get(ConfigService);
  app.enableCors({
    origin: config.getOrThrow<string>("UI_ORIGIN"),
  });
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
```

`process.env.PORT` reste acceptable : `bot.ts` **est** le composition root.

### 9.1 bis — ne pas attendre `bot.launch()`

Jusqu’ici l’HTTP ne servait à rien, donc ce bug ne se voyait pas : dans
`TelegramInboundAdapter.onModuleInit`, `await this.bot.launch()` **ne rend
jamais la main** (la promesse de Telegraf résout à l’*arrêt* du bot). Nest
n’atteint donc jamais `app.listen()` et le port 3000 refuse la connexion — la
UI affiche « NetworkError when attempting to fetch resource ».

Dans `agents/src/infrastructure/adapters/telegram/TelegramInboundAdapter.ts`,
remplace `await this.bot.launch();` par :

```ts
    // `launch()` ne résout qu'à l'arrêt du bot : l'attendre bloquerait
    // `onModuleInit`, et donc le `app.listen()` qui expose /auth/siwe.
    void this.bot
      .launch(() => this.logger.log("Telegram long polling started"))
      .catch((err) =>
        this.logger.error(
          "Telegram long polling stopped",
          err instanceof Error ? err.stack : String(err),
        ),
      );
```

Au boot tu dois voir **les deux** lignes :

```text
[NestApplication] Nest application successfully started
[TelegramInboundAdapter] Telegram long polling started
```

### 9.2 Providers dans `BotModule`

Dans `agents/src/bootstrap/BotModule.ts` :

1. Ajoute `controllers: [SiweAuthController]`.
2. Élargis le factory de `HandleIncomingMessage`.
3. Ajoute les providers SIWE (un store **singleton** partagé challenge + binding).

Imports à ajouter :

```ts
import { SiweBindPolicy } from '../domain/identity/SiweBindPolicy.js';
import { CLOCK_PORT, type ClockPort } from '../app/ports/clock/ClockPort.js';
import {
  IDENTITY_STORE_PORT,
  type IdentityStorePort,
} from '../app/ports/identity/IdentityStorePort.js';
import {
  TOKEN_GENERATOR_PORT,
  type TokenGeneratorPort,
} from '../app/ports/identity/TokenGeneratorPort.js';
import {
  SIWE_VERIFIER_PORT,
  type SiweVerifierPort,
} from '../app/ports/identity/SiweVerifierPort.js';
import type { SiweIssuance } from '../app/use-cases/SiweAuth/SiweIssuance.js';
import { GetSiweChallenge } from '../app/use-cases/SiweAuth/GetSiweChallenge.js';
import { CompleteSiweBind } from '../app/use-cases/SiweAuth/CompleteSiweBind.js';
import { SystemClockAdapter } from '../infrastructure/adapters/clock/SystemClockAdapter.js';
import { InMemoryIdentityStore } from '../infrastructure/adapters/identity/InMemoryIdentityStore.js';
import { ViemSiweNonceAdapter } from '../infrastructure/adapters/siwe/ViemSiweNonceAdapter.js';
import { ViemSiweVerifierAdapter } from '../infrastructure/adapters/siwe/ViemSiweVerifierAdapter.js';
import { SiweAuthController } from '../infrastructure/adapters/http/SiweAuthController.js';
```

Token de config (à côté des autres `Symbol` du fichier, ou juste avant `@Module`) :

```ts
const SIWE_ISSUANCE = Symbol('SiweIssuance');
```

`@Module` — `controllers` + providers à insérer **avant** le factory
`HandleIncomingMessage` existant, puis **remplacer** ce factory :

```ts
@Module({
  imports: [EnsCoreModule],
  controllers: [SiweAuthController],
  providers: [
    // ... Agent, CONVERSATION_PORT, ENS watch : inchangés ...

    { provide: CLOCK_PORT, useClass: SystemClockAdapter },
    { provide: TOKEN_GENERATOR_PORT, useClass: ViemSiweNonceAdapter },
    { provide: IDENTITY_STORE_PORT, useClass: InMemoryIdentityStore },
    { provide: SIWE_VERIFIER_PORT, useClass: ViemSiweVerifierAdapter },
    { provide: SiweBindPolicy, useValue: new SiweBindPolicy() },
    {
      provide: SIWE_ISSUANCE,
      useFactory: (config: ConfigService): SiweIssuance => ({
        domain: config.getOrThrow<string>('SIWE_DOMAIN'),
        chainId: Number(config.getOrThrow<string>('SIWE_CHAIN_ID')),
        statement: config.getOrThrow<string>('SIWE_STATEMENT'),
        uiOrigin: config.getOrThrow<string>('UI_ORIGIN'),
      }),
      inject: [ConfigService],
    },
    {
      provide: GetSiweChallenge,
      useFactory: (
        identities: IdentityStorePort,
        clock: ClockPort,
        policy: SiweBindPolicy,
        issuance: SiweIssuance,
      ) => new GetSiweChallenge(identities, clock, policy, issuance),
      inject: [IDENTITY_STORE_PORT, CLOCK_PORT, SiweBindPolicy, SIWE_ISSUANCE],
    },
    {
      provide: CompleteSiweBind,
      useFactory: (
        identities: IdentityStorePort,
        verifier: SiweVerifierPort,
        messaging: OutboundMessagingPort,
        clock: ClockPort,
        policy: SiweBindPolicy,
        issuance: SiweIssuance,
      ) =>
        new CompleteSiweBind(
          identities,
          verifier,
          messaging,
          clock,
          policy,
          issuance,
        ),
      inject: [
        IDENTITY_STORE_PORT,
        SIWE_VERIFIER_PORT,
        MESSAGING_PORT,
        CLOCK_PORT,
        SiweBindPolicy,
        SIWE_ISSUANCE,
      ],
    },
    {
      provide: HandleIncomingMessage,
      useFactory: (
        conversation: ConversationPort,
        messaging: OutboundMessagingPort,
        agent: Agent,
        identities: IdentityStorePort,
        tokens: TokenGeneratorPort,
        clock: ClockPort,
        policy: SiweBindPolicy,
        issuance: SiweIssuance,
      ) =>
        new HandleIncomingMessage(
          conversation,
          messaging,
          agent,
          identities,
          tokens,
          clock,
          policy,
          issuance,
        ),
      inject: [
        CONVERSATION_PORT,
        MESSAGING_PORT,
        Agent,
        IDENTITY_STORE_PORT,
        TOKEN_GENERATOR_PORT,
        CLOCK_PORT,
        SiweBindPolicy,
        SIWE_ISSUANCE,
      ],
    },

    // ... TelegramInboundAdapter, ENS_WATCH_SCHEDULER_PORT, watch use cases : inchangés ...
  ],
})
export class BotModule {}
```

`MESSAGING_PORT` est déjà importé depuis `OutboundMessagingPort.js` via
`EnsCoreModule` — le token est exporté par `EnsCoreModule`. Vérifie que
`BotModule` importe bien `MESSAGING_PORT` (aujourd’hui il importe le **type**
`OutboundMessagingPort` et le token depuis le port file : ajoute le token si
besoin) :

```ts
import {
  MESSAGING_PORT,
  type OutboundMessagingPort,
} from '../app/ports/messaging/OutboundMessagingPort.js';
```

(`EnsCoreModule` exporte `MESSAGING_PORT` : le même `Symbol` est injectable.)

`SiweAuthController` déclare `GetSiweChallenge` et `CompleteSiweBind` dans son
constructeur : Nest les résout parce qu’ils sont `provide: GetSiweChallenge`
(classe = token). Pas de `@Injectable()` sur les use cases.

### 9.3 Tests agents

```bash
cd agents
pnpm test
pnpm run lint
```

`HandleIncomingMessage.spec` d’avant (sans mur) **doit** disparaître : le
nouveau spec le remplace.

---



## 10. Étape — UI Next (deep link)

Le dossier `ui/` n’a aujourd’hui que le README. Scaffold **dans** `ui/` :

```bash
cd ui
pnpm create next-app . --typescript --tailwind --eslint --app --src-dir false --import-alias "@/*" --use-pnpm --yes
pnpm add wagmi viem @tanstack/react-query
```

Si `create-next-app` refuse un dossier non vide, crée les fichiers ci-dessous
à la main sur un App Router Next 15.

Mets à jour `ui/.env.example` et `ui/.env.local` :

```bash
NEXT_PUBLIC_AGENTS_URL=http://localhost:3000
NEXT_PUBLIC_SIWE_CHAIN_ID=1
```

`NEXT_PUBLIC_SIWE_CHAIN_ID` doit égaler `SIWE_CHAIN_ID` du bot.

### 10.1 Config wagmi

`ui/lib/wagmi.ts` :

```ts
import { http, createConfig } from "wagmi";
import { mainnet, sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const wagmiConfig = createConfig({
  chains: [mainnet, sepolia],
  connectors: [injected()],
  // Sans ça, le serveur rend « Connect wallet » et le client, déjà reconnecté
  // depuis le storage, rend l'adresse : hydration mismatch.
  ssr: true,
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
});
```



### 10.2 Providers

`ui/src/app/providers.tsx` (l’import remonte deux crans : `../../lib/wagmi`) :

```tsx
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "../lib/wagmi";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
```

Dans `ui/src/app/layout.tsx`, enveloppe `{children}` avec `<Providers>`.

### 10.3 Page `/siwe`

`ui/src/app/siwe/page.tsx` :

```tsx
"use client";

import { createSiweMessage } from "viem/siwe";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAccount, useConnect, useSignMessage } from "wagmi";
import { injected } from "wagmi/connectors";

const AGENTS = process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3000";

type Challenge = {
  nonce: string;
  domain: string;
  uri: string;
  chainId: number;
  statement: string;
  version: "1";
  issuedAt: string;
  expirationTime: string;
};

/** Le `message` de l'agent distingue « lien inconnu » de « lien expiré ». */
async function reason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

function SiweForm() {
  const token = useSearchParams().get("token") ?? "";
  const { address, isConnected } = useAccount();
  const { connect, isPending: connecting } = useConnect();
  const { signMessageAsync, isPending: signing } = useSignMessage();
  const [status, setStatus] = useState<string>("");
  // L'état du wallet n'existe pas côté serveur. Tant que `mounted` est faux,
  // le client rend exactement le HTML du serveur : plus de mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const walletReady = mounted && isConnected;

  async function onSign() {
    try {
      await bind();
    } catch (err) {
      // Agent injoignable, signature refusée dans le wallet : un throw ici
      // remonterait en unhandledRejection au lieu d'informer l'utilisateur.
      setStatus(err instanceof Error ? err.message : "Sign-in failed");
    }
  }

  async function bind() {
    if (!token || !address) return;
    setStatus("Loading challenge…");
    const res = await fetch(
      `${AGENTS}/auth/siwe/challenge?token=${encodeURIComponent(token)}`,
    );
    if (!res.ok) {
      setStatus(`Challenge failed (${res.status}): ${await reason(res)}`);
      return;
    }
    const challenge = (await res.json()) as Challenge;
    const message = createSiweMessage({
      address,
      chainId: challenge.chainId,
      domain: challenge.domain,
      nonce: challenge.nonce,
      uri: challenge.uri,
      version: "1",
      statement: challenge.statement,
      issuedAt: new Date(challenge.issuedAt),
      expirationTime: new Date(challenge.expirationTime),
    });
    setStatus("Sign in your wallet…");
    const signature = await signMessageAsync({ message });
    setStatus("Verifying…");
    const verify = await fetch(`${AGENTS}/auth/siwe/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: challenge.nonce,
        address,
        message,
        signature,
      }),
    });
    if (!verify.ok) {
      setStatus(`Verify failed (${verify.status}): ${await reason(verify)}`);
      return;
    }
    setStatus("Linked. Go back to Telegram and send a new message.");
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 480 }}>
      <h1>DeFiCat — Sign-In with Ethereum</h1>
      {!token ? <p>Missing token. Open the link from Telegram.</p> : null}
      {!walletReady ? (
        <button
          type="button"
          disabled={connecting}
          onClick={() => connect({ connector: injected() })}
        >
          Connect wallet
        </button>
      ) : (
        <p>Connected: {address}</p>
      )}
      <p>
        <button
          type="button"
          disabled={!token || !walletReady || signing}
          onClick={() => void onSign()}
        >
          Sign SIWE
        </button>
      </p>
      <p>{status}</p>
    </main>
  );
}

export default function SiwePage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <SiweForm />
    </Suspense>
  );
}
```

La UI **ne décide pas** que l’auth a réussi : elle affiche la réponse de
l’agent. Le bot notifie Telegram tout seul.

Le fichier `ui/src/app/siwe/page.tsx` du repo est la source à copier : `busy`
anti double-clic, `connectAsync` avec message si aucun wallet, `parseChallenge`
si le JSON est pourri, `getAddress` pour que le message SIWE matche l’agent.

---



## 11. Checklist de demo

1. `agents/.env` : `UI_ORIGIN`, `SIWE_DOMAIN`, `SIWE_CHAIN_ID`, `SIWE_STATEMENT`.
2. `ui/.env.local` : `NEXT_PUBLIC_AGENTS_URL`, `NEXT_PUBLIC_SIWE_CHAIN_ID`.
3. Deux process :

```bash
cd agents && pnpm run start:dev          # :3000 + Telegram long poll
cd ui && pnpm run dev --port 3001     # :3001
```

1. MetaMask sur la **même chaîne** que `SIWE_CHAIN_ID`.
2. Envoie `gm` au bot → message avec `http://localhost:3001/siwe?token=…`.
3. Ouvre le lien **sur la machine où tourne la UI** (localhost). En demo
  jury / téléphone : expose la UI (tunnel) et aligne `UI_ORIGIN` +
   `SIWE_DOMAIN` sur ce host public.
4. Connect → Sign → retour Telegram « Wallet 0x… is linked ».
5. Envoie un **nouveau** `gm` → LangGraph répond.
6. Attends 15 min sans signer → le GET challenge et un second message Telegram
  émettent un **nouveau** token.

Preuve hors Telegram que le mur tient :

```bash
cd agents
pnpm test src/app/use-cases/HandleIncomingMessage
# le spec « does not call the LLM when unbound » doit rester vert
```

---



## 12. Pièges


| Piège                                     | Pourquoi ça casse                        | Que faire                               |
| ----------------------------------------- | ---------------------------------------- | --------------------------------------- |
| `SIWE_DOMAIN` avec `http://`              | EIP-4361 `domain` = authority, pas d’URL | `localhost:3001` ou `deficat.example`   |
| UI en `127.0.0.1` et domain `localhost`   | MetaMask / vérif voient un autre host    | même host partout                       |
| Wallet sur Sepolia, `chainId` 1           | signature refusée                        | aligner chaîne wallet = `SIWE_CHAIN_ID` |
| Nouveau nonce à chaque « gm »             | le lien déjà ouvert 401                  | `ensureChallenge` réutilise le TTL      |
| Cookie / JWT UI comme preuve Telegram     | hostile, forgeable                       | seul `IdentityStore` après `verify`     |
| `createSiweMessage` différent UI vs agent | `message !== expected`                   | **mêmes** champs, même lib `viem/siwe`  |
| Logger le POST verify                     | fuite de signature                       | loguer seulement `chat` / adresse       |
| Store dans le worker                      | deux mémoires, bind invisible au bot     | SIWE **uniquement** `BotModule`         |
| `await bot.launch()` dans `onModuleInit`  | `app.listen()` jamais atteint, port 3000 refusé | `void bot.launch(...)` (§9.1 bis) |
| `createConfig` sans `ssr: true`           | SSR rend le bouton, le client rend l'adresse : hydration mismatch | `ssr: true` |
| lire `isConnected` au premier rendu       | `ssr: true` ne suffit pas pour `disabled` : mismatch d'attribut | garde `mounted` (`walletReady`) |
| `onSign` sans `try/catch`                 | fetch KO ou signature refusée → `unhandledRejection` muet | wrapper + `setStatus` |
| Restart du bot pendant la demo            | mémoire vidée                            | relier le wallet (v1)                   |
| `start:dev` recompile pendant que le lien est ouvert | watch mode = store vidé → `Challenge failed (401)` | redemander un lien dans Telegram |
| ERC-1271 / Safe                           | `verifyMessage` EOA only                 | hors v1                                 |
| Rejouer le premier texte                  | hors v1                                  | « Send a message to continue »          |


Ordre de build (hexagone) : **domain → ports → use cases + fakes → adapters →
bootstrap → UI**. Tu peux t’arrêter après l’étape 6 et avoir le mur testé sans
Telegram ni MetaMask.