# Hexagonal architecture

## Why we use it

**Business rules sit in the middle. Telegram, A2A, Next.js, The Graph, 1inch, and x402 sit on the edge.**

That way we can add a new channel (another bot, another agent protocol) or swap a vendor (another indexer, another DEX aggregator) without rewriting “when to charge”, “what an insight is”, or “whether this swap is allowed”.

**Nest / Next are not the application.** They are how the world talks to the application. `@nestjs/*`, React, Telegraf, LangChain, viem never enter `domain/` or `app/`.

## Picture

```text
  Telegram · A2A · HTTP · UI · cron
                 │  driving adapters (world → app)
                 ▼
        ┌─────────────────────────┐
        │  app/   use cases       │  orchestrate one intention
        │         + ports         │  holes in the hexagon
        │    ┌───────────────┐    │
        │    │  domain/      │    │  pure rules — no I/O
        │    └───────────────┘    │
        └─────────────────────────┘
                 │  driven adapters (app → world)
                 ▼
  x402 · The Graph · 1inch · LLM · DB

  bootstrap/  wires everything (Nest AppModule / Next createRequestCore)
```

| Kind | Direction | Examples in DeFiCat |
| --- | --- | --- |
| **Driving** | world → app | Telegram handler, A2A/HTTP controller, Next page, cron |
| **Driven** | app → world | The Graph client, 1inch client, x402 verify/charge, LLM |

## Layers (where the file goes)

| Layer | Owns | Does **not** own |
| --- | --- | --- |
| `domain/` | Invariants, pricing, eligibility, identity, “should we run this service?” | HTTP, Telegram, SDKs, `process.env`, `Date.now()` |
| `app/` | One use case per intention (`execute`), **ports** (interfaces we own) | Nest `@Injectable` / `@Controller`, Prisma, Telegraf |
| `infrastructure/` | Translate SDK ↔ our types. Controllers call `execute`. Adapters **implement** ports | Business `if` (limits, prices, authz *decisions*) |
| `bootstrap/` | `main.ts`, `AppModule`, `new Sdk()`, env | Domain rules |
| `ui/` (Next package) | Pages, forms, view-models | `policy.shouldBuy()` — call a use case instead |

**Law:** dependencies point **inward**. Outer may import inner. Inner never imports outer.

| From ↓ | May import |
| --- | --- |
| `domain/` | only `domain/` |
| `app/` | `app/`, `domain/` |
| `infrastructure/` | `infrastructure/`, `app/`, `domain/`, SDKs |
| `ui/` | `ui/`, use-case/port **types**, identifiers — not infrastructure SDKs |
| `bootstrap/` | everything (it wires) |

## How to add a feature

Example: “pay with x402, then return a Graph insight”.

1. **Name the intention** — one verb phrase → one class with `execute` (e.g. `GetOnchainInsight`).
2. **Put rules in `domain/`** — what is paid, what is a valid query, when the result is allowed. Unit test. No I/O.
3. **Cut a port** in `app/ports/` for each thing we do not own (`GraphPort`, `X402Port`, `OneInchPort`). Our types only — never `ChatOpenAI`, `Telegraf`, `PrismaClient`.
4. **Orchestrate in the use case** — load via ports → ask domain → persist/notify via ports. Plain TypeScript, **no** `@Injectable()`.
5. **Translate in adapters** — GraphQL/1inch/x402/Telegram/HTTP. Nest `@Controller` only captures intent and calls `execute`.
6. **Wire in `bootstrap/`** — `useFactory` + port `Symbol` tokens. `new Sdk()` and env **only here**.
7. **Test core offline** — fakes for ports. No `Test.createTestingModule` for domain or use cases.

Build order: **domain → ports → use case → fake adapter → one driving adapter → real adapters**.

## Naming

| Thing | Convention |
| --- | --- |
| Port | `SomethingPort` + `SOMETHING_PORT = Symbol(...)` |
| Driven adapter | `SomethingAdapter` implements the port |
| Driving adapter | Controller / Telegram inbound / `@Cron` → `execute` |
| Use case | Verb-phrase class, `execute(...)` |
| Value object | `static of(raw)`, private constructor |
| Domain error | `DomainError` (adapters map to HTTP / Telegram copy) |

## Do / don't

**Do**

- One use case per user intention (Telegram message, A2A call, “pay then swap”).
- Pricing and eligibility in `domain/`, even if a Nest guard also checks a cookie.
- Log via `LoggerPort` or only inside adapters — not `console` as architecture.

**Don't**

- Put Telegraf, LangChain, The Graph SDK, 1inch SDK, or `@nestjs/*` in `domain/` or `app/`.
- Put business `if` in a controller, a React component, or `AppService`.
- `new GraphClient()` inside a use case, a controller, or a Next page.
- Leak SDK types through a port (`ChatOpenAI`, `Telegraf`, `PrismaClient`).
- Read `process.env` outside `bootstrap/` (or a tiny config helper called **only** from bootstrap).

## DeFiCat mapping

| Intention | Driving | Domain | Driven ports |
| --- | --- | --- | --- |
| Ask for an insight | Telegram / A2A / HTTP | What may be queried, what it costs | `GraphPort`, `X402Port` |
| Do a DeFi op | Telegram / A2A / HTTP | What may be swapped, limits | `OneInchPort`, `X402Port` |
| Pay | UI (SIWE + x402) / agent 402 flow | Receipt / paid-or-not | x402 adapter, wallet stays in UI |

Same use cases. Different adapters. That is the hexagon.
