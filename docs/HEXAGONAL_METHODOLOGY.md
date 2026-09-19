# Hexagonal methodology — new capability (NestJS)

> **Audience:** you, becoming autonomous. Coding agents may follow this too.  
> **Law & import matrix:** [HEXAGONAL.md](./HEXAGONAL.md) (one page) · [HEXAGONAL_FULL.md](./HEXAGONAL_FULL.md) (detail).  
> **This file:** *how to think* when adding anything. Copy it to another Nest hexagon; swap the examples.  
> **Nest is not the application.** Nest is composition root + driving adapters. `@nestjs/*` never enters `domain/` or `app/`.

---

## 0. Mindset (read this until it is boring)

1. **Name an intention, not a vendor.** “Buy an available .eth” is a use case. “Add Telegraf” / “Add x402” is not.
2. **Design order ≠ runtime order.** You design from the centre. The process starts from the edge.
3. **One use case = one verb phrase = one `execute`.** Do not grow a Nest `*Service` god object.
4. **Rules have no I/O.** If a decision needs Telegram, Prisma, or `Date.now()`, you have put the rule in the wrong layer (or you need a `ClockPort`).
5. **Ports are sockets. Adapters are plugs.** Consumers inject the socket. Bootstrap chooses the plug.
6. **The app is always driven.** Nothing “starts” in a use case. The world pushes; the use case orchestrates; ports pull the world.

If a change would violate the import matrix, stop and redesign. Do not “just this once”.

---

## 1. Two arrows (do not mix them)

```text
DESIGN (you write files in this order)

  intention → domain → use case + ports → fake adapters → driving/driven adapters → bootstrap


RUNTIME (the process actually runs this way)

  world → driving adapter → use case.execute()
                                ├─ domain (pure)
                                └─ ports → driven adapters → world

  bootstrap/ only wires. It is not a business entry point.
```

Your two questions:

| Arrow | When it is true |
| --- | --- |
| `use case + domain + port → adapter` | **Design**, and every **outbound** call |
| `adapter → use case + domain + port` | **Runtime inbound** only |

You do not choose 1 vs 2. Inbound *arrives* through an adapter. Outbound *leaves* through a port. The use case stays the centre.

---

## 2. Inbound vs outbound (same centre, different edge question)

| | New **trigger** (inbound / driving) | New **system** (outbound / driven) |
| --- | --- | --- |
| Question | Who **pushes** the app? (HTTP, Telegram, cron, Temporal, CLI) | What does the use case **need** from the world? (DB, chain, LLM, pay) |
| You add | Driving adapter that maps the world → `execute` | Port + driven adapter that implements it |
| Use case | Often **the same** (`HandleIncomingMessage` from Telegram *and* WhatsApp) | Often **the same** (`PurchaseEnsName` + a new registrar adapter) |
| Domain | Unchanged | Unchanged |
| Nest `provide` | The **adapter class** (nothing in `app/` injects it) | The **port `Symbol`** (`MESSAGING_PORT` → `new TelegramOutboundAdapter`) |

**Driving adapters have no port** — the application never *asks* “give me the Telegram listener”. Nest still lists them in `providers` so it can construct them and run `onModuleInit` / `onModuleDestroy`.

**Two vendors for the same intention = two adapters, one port.** WhatsApp is not `WHATSAPP_MESSAGING_PORT`. It is another plug on `MESSAGING_PORT` (or a composite adapter that switches on `message.channel`).

---

## 3. Procedure (always this order)

Skip a step only if it is truly empty (e.g. no new rule, reuse an existing port). Never start with Nest, the SDK, or a CRUD list of ports.

### Step 0 — Intention

One sentence a human (or another agent) would say.

- Good: “Bind this Telegram chat to a wallet”, “Quote then buy this .eth”, “Create a payment session for this paid intent”.
- Bad: “Add a billing module”, “Integrate LangGraph”, “Expose a controller”.

One intention → one use-case class. A user-facing **product** (SKU) may chain several intentions (issue session → settle payment → fulfill). That is several use cases, not one soup.

Write the name of `execute`’s input/output in a comment or on paper *before* files.

### Step 1 — Domain (always first when there are rules)

Ask:

1. What still exists if Nest, Telegram, and the chain disappear?
2. What **must not** be false? (duration 1–5 years, expired session, unknown SKU, checksummed address)
3. What **states** and transitions? (challenge open → consumed; watch `scheduled` → `bought`)

Two shapes — both correct:

| Shape | When | Examples in this repo |
| --- | --- | --- |
| **Type / snapshot** | A fact, a document, a value | `PaymentSession`, `PaidIntent`, `EnsDropWatch`, `ServiceOffer` |
| **Class + methods** | Decisions, normalisation, invariants | `EnsPurchasePolicy.validate`, `SiweBindPolicy.assertActive`, `offerFor(sku)` |

**Rule of thumb:** if it contains a business `if`, it is a policy / domain function. If it only carries fields, it is a type.

Data *flows* between those objects are usually **typed structures**, not extra classes: `EnsPurchaseRequest` → `ValidatedEnsPurchase`. Orchestration (load, call chain, notify) is **not** domain — that is the use case.

Put a **unit test next to the policy**. It must run offline: no ports, no Nest, no `TestingModule`.

`domain/` never: `process.env`, SDK types, `@Injectable()`, `Date.now()` (inject time via `ClockPort` at the use-case boundary), loggers from infra.

### Step 2 — Use case (scenario, not the rules)

Always the same loop:

1. Load / receive (`execute` args + ports)
2. Ask **domain** (`validate`, `assert*`, `offerFor`)
3. Talk to the world (other ports)
4. Map I/O failures to **application** errors (`EnsPurchaseError`), keep `DomainError` for invariant violations

Use cases are **plain classes**. No `@Injectable()`, no `ConfigService`, no `new Sdk()`.

`validate` / `quote` helpers on the use case are fine when they only wrap domain + a port (`PurchaseEnsName`). They must not invent new pricing `if`s.

### Step 3 — Ports (capabilities the use case actually calls)

**Not** a generic CRUD catalogue (“save, get, validate, search, delete”).

- **Validate** is almost always **domain**, not a port. A `ValidatorPort` is a smell unless validation *is* I/O (e.g. SIWE signature → `SiweVerifierPort`).
- Design the port by writing the use case with **imagined** calls, then keep only methods you call.
- Types on the port are **yours** (`PaymentSession`, not Prisma rows, not Telegraf `Context`, not `ChatOpenAI`).
- One port = one **reason to change** (identity store vs ENS registrar vs outbound messaging). Reuse a port across use cases; do not clone it per feature.

Export next to the interface:

```ts
export const MESSAGING_PORT = Symbol('OutboundMessagingPort');

export interface OutboundMessagingPort {
  send(message: OutboundMessage): Promise<void>;
}
```

`Symbol` exists because **interfaces are erased at runtime**. Nest cannot `inject: [OutboundMessagingPort]`.

Add `list` / `search` when a **second** use case needs them, not “just in case”.

### Step 4 — Fake adapters (before the real SDK)

In-memory implementations of the port. Use-case tests inject fakes. The walking skeleton boots without Telegram or a chain.

### Step 5 — Real adapters

**Driven:** implement the port; map SDK → your types; map SDK errors → port errors (`EnsRegistrationError`). No business `if` that belongs in domain (budget, eligibility).

**Driving:** parse (Zod, Telegraf filter); **no** pricing/eligibility `if`; call `execute`; map `DomainError` → HTTP status / chat copy.

Telegram (and similar) extras (`username`, `entities`, `language_code`) stay in the adapter until the **inbound contract** needs them. Identity keys (`recipientId`) stay **stable ids** (chat id), never a mutable `@pseudo`.

`entities` are Telegram annotations on `text` (commands, mentions, URLs). Ignore them until you parse commands *before* the LLM.

### Step 6 — Bootstrap last

`useFactory`, env, `new Sdk()` **only here**.

| What you bind | Nest token |
| --- | --- |
| Port (interface) | `provide: MESSAGING_PORT` → `new TelegramOutboundAdapter(bot)` |
| Unique concrete class (use case, policy, `Agent`) | `provide: HandleIncomingMessage` (the class **is** the token) |
| Shared SDK / parsed config (not a port) | `Symbol` in **bootstrap** (`TELEGRAM_BOT`, `ETHEREUM_NETWORK`) — never in `domain/` |
| Driving adapter | `provide: TelegramInboundAdapter` so Nest constructs it and runs lifecycle hooks |

Split modules when **two processes** would otherwise duplicate wiring (this repo: `EnsCoreModule` for bot + Temporal worker). Shared = driven ports + policies + use cases both need. Inbound Telegram stays on the bot module.

Lifecycle: `OnModuleInit` / `OnModuleDestroy` are **Nest duck-typing** on providers (`onModuleInit` method name). Not a JS keyword. `@Injectable()` is DI metadata, **not** what enables the hook. A `new` outside `providers` never gets `onModuleInit`.

Optional `Adapter.create(opts)` vs `constructor(opts)`: **same boot time**. Factory only splits “build the graph/SDK” from a tiny constructor (easier fakes). Not lazy. Fail at boot if keys/graph are wrong, not on the first message.

---

## 4. Nest tokens (cheat sheet)

| Kind | Token | Why |
| --- | --- | --- |
| Port | `FOO_PORT = Symbol('FooPort')` next to the interface in `app/ports/` | Runtime key for an erased interface; swap adapters without touching `app/` |
| Use case / policy class | The class | Exists at runtime; one implementation |
| Composition-only object | `Symbol` in `bootstrap/` | Telegraf instance, parsed chain config, allowlist `Set` from env |
| Driving adapter | The class in `providers` | Instantiation + `onModuleInit`, not injection into the hexagon |

Do **not** name the port after the vendor (`TELEGRAM_MESSAGING_PORT`). Name the **capability**.

The env allowlist (`ENS_BUYER_CHAT_IDS`) is a **bucket** filled in bootstrap. “Who may spend” as a *decision* belongs in domain if you encode it as policy. The `Symbol` stays at the composition root.

---

## 5. Product overlay: “any paid service” (SKU)

A **service** in the product sense is not one Nest module. It is:

1. Catalogue + intent in **domain** (`ServiceSku`, `PaidIntent`, `offerFor`, `skuFor`)
2. Stable **billing** use cases (issue session, settle, fulfill) — not one pay use case per SKU
3. A **fulfillment** use case per family (`PurchaseEnsName`, `ScheduleEnsPurchase`, …)
4. Driving: chat/LLM offers a link; HTTP/x402 settles; fulfill dispatches on `intent.type`

x402 / CDP / Telegram appear **only** in adapters. The UI renders; it does not price.

Same procedure as §3. Do not start by copying an SDK sample into a controller.

---

## 6. Checklist before you open Nest

- [ ] Intention named (one verb)
- [ ] Invariants listed; live without I/O?
- [ ] Type vs policy chosen (`if` métier → policy)
- [ ] `execute`: load → domain → ports
- [ ] Port verbs = what this use case calls; types we own
- [ ] Domain test + use-case test with fakes (offline)
- [ ] Driving = parse + `execute`; driven = SDK translation
- [ ] Bootstrap: `new` / env / bind only
- [ ] Import matrix still holds (`pnpm lint:boundaries` if you have it)
- [ ] No business `if` in controller, Telegram handler, LangGraph tool, or React

If you are stuck: **write the use case in comments**, make domain compile, then port signatures. Adapters and Nest wait until `execute` is green with fakes.

---

## 7. Where the file goes

| You are touching… | Put it in |
| --- | --- |
| Invariant, policy, value object, catalogue | `domain/` |
| `execute`, port interface, port `Symbol` | `app/` |
| ky, Prisma, viem, LangGraph, Telegraf, Nest `@Controller` / guard / filter | `infrastructure/` |
| `AppModule` / `BotModule`, `main.ts`, `ConfigModule.forRoot`, composition `Symbol`s | `bootstrap/` |
| Page, hook, form, view-model | `ui/` package — not `policy.shouldBuy()` |

---

## 8. Anti-patterns (stop the line)

| Smell | Do this instead |
| --- | --- |
| Start with the SDK / `nest g resource` | Intention → domain → use case |
| Port named after Telegram / Prisma / x402 | Capability name + map in the adapter |
| CRUD port “for later” | Methods the use case calls today |
| Pricing `if` in controller, tool description, or UI | Domain policy + test |
| `@Injectable()` / `ConfigService` on a use case | Plain class; factory in bootstrap |
| `HANDLE_INCOMING_MESSAGE = Symbol` for a unique class | `provide: HandleIncomingMessage` |
| Second port because second channel | Second **driving** adapter, same `execute` |
| `new SomeSdk()` in use case or controller | Bootstrap `useFactory` |
| Domain imports `infrastructure/` or `@nestjs/*` | Port or move the code |
| LangGraph graph built inside a use case | `ConversationPort` + adapter `create` |

---

## 9. This repo as a map (optional)

Use when learning; drop when copying the doc to another product.

| Intention | Driving | Use case | Port(s) | Driven |
| --- | --- | --- | --- | --- |
| Chat message | `TelegramInboundAdapter` | `HandleIncomingMessage` | `ConversationPort`, `OutboundMessagingPort`, `IdentityStorePort` | LangGraph, Telegram out, in-memory identity |
| Buy .eth | LLM tool → use case | `PurchaseEnsName` | `EnsRegistrarPort` | viem |
| SIWE HTTP | `SiweAuthController` | `GetSiweChallenge` / `CompleteSiweBind` | identity + verifier + clock | viem / store |
| Watch drop | LLM tool / Temporal worker | `ScheduleEnsPurchase` + worker fulfill | `EnsWatchSchedulerPort` | Temporal or in-memory |

`EnsCoreModule`: shared driven wiring (bot + worker). `BotModule`: inbound chat + LangGraph. `WorkerModule`: Temporal process. `TELEGRAM_BOT` is a composition token (the Telegraf instance), not a port.

---

## 10. Copy-paste prompt for yourself (or an agent)

```text
Follow HEXAGONAL.md import matrix and docs/HEXAGONAL_METHODOLOGY.md.
New capability: <one verb phrase>.
Work domain → use case + ports → fakes → adapters → bootstrap.
Do not put @nestjs, SDKs, or env in domain/ or app/.
Ports: our types; Symbol next to the interface; named by capability not vendor.
Driving adapters call execute only. Driven adapters implement ports.
```
