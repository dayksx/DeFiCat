# 🤖 Agents

NestJS + Node.js + TypeScript. Agents that expose **onchain insights (The Graph)**, **ENS registrations (viem)** and **DeFi operations (1inch)**, and require an **x402 payment** before they run. No pay, no play. 😼

Product context: [../README.md](../README.md).

## 🐱 Role in DeFiCat

This process is the composition root for Telegram, A2A, and paid tools. The UI does not contain agent logic; it authenticates wallets and completes payments that this service requested.

```text
Telegram / A2A / HTTP
        │  driving adapters
        ▼
   use cases (app/)  →  domain (pricing, eligibility, insights rules)
        │  ports
        ▼
   x402, The Graph, 1inch, ENS, Temporal, LLM, Telegram API  (infrastructure/)
```

Nest (`bootstrap/`) wires adapters. `@nestjs/*` does not enter `domain/` or `app/`. See [docs/HEXAGONAL.md](../docs/HEXAGONAL.md).

## ⚠️ Two processes, not one

A scheduled ENS purchase waits for months, so it cannot live in the bot's memory. The package therefore ships **two entrypoints** that share the same adapters through `EnsCoreModule`.

```text
bootstrap/bot.ts           bootstrap/worker.ts
  BotModule                  WorkerModule
  ├─ Telegraf (launch)       ├─ Temporal Worker (polls the task queue)
  ├─ LangGraph + tools       └─ activities: quote, commit, register, notify
  └─ ScheduleEnsPurchase
        │                              ▲
        └── starts a workflow ─────────┘
              (Temporal server holds the timer)
```

The bot only **arms and cancels** watches. The purchase itself is signed months later by the worker. Both processes load `AGENT_PRIVATE_KEY`, but only one signs at a time, so run **a single worker** in production: the two share one EOA, and therefore one nonce.


## ✨ Features

| Surface | What it does | Status |
| --- | --- | --- |
| 💬 Telegram bot | Conversation via LangGraph, ENS tools, web search | ✅ Working |
| 📊 ENS insights | Owner, expiry and grace-period end via [The Graph](https://thegraph.com) | ✅ Working (`lookup_ens`) |
| 🛒 ENS purchase | Quote then commit/reveal registration, allowlist + budget capped | ✅ Working (`purchase_ens`) |
| ⏳ Scheduled ENS purchase | Buy a taken name the moment it drops, within budget | ✅ Working (`schedule_ens`, `list_ens_watches`, `cancel_ens_watch`) |
| 🤝 A2A | Other agents discover and call the same paid services | Planned |
| 💳 x402 | Service returns 402 until paid, then runs | Planned |
| 🔄 DeFi operations | Swaps and related actions via [1inch](https://1inch.io) | Planned |
| ❤️ HTTP health | Process listens (`PORT`, default 3000) | ✅ Working |

The agent only offers `schedule_ens` when a quote comes back with `schedulable=true`, meaning the name is taken or above budget. Arming a watch needs the exact confirmation phrase, since the purchase later happens without asking again.

## 🏗️ Architecture (this package)

```text
src/
  domain/                    # invariants, value objects — no I/O
    ens/                     # EnsPurchasePolicy, EnsDropWatch
  app/
    ports/                   # conversation, ens, graph, messaging, watch
    use-cases/               # HandleIncomingMessage, PurchaseEnsName,
                             #   EnsWatch (schedule, list, cancel)
  infrastructure/adapters/
    telegram/ langgraph/     # driving + driven chat adapters
    thegraph/ ens/           # ENS reads (The Graph) and writes (viem)
    temporal/                # workflow, activities contract, scheduler adapter
    watch/                   # in-memory scheduler, for dev and tests
  bootstrap/
    EnsCoreModule.ts         # shared by both processes
    BotModule.ts  bot.ts     # bot process
    WorkerModule.ts worker.ts# Temporal worker process
```

## ✅ Prerequisites

- Node.js 20+
- pnpm (this package pins `packageManager` in `package.json`)
- Telegram bot token (BotFather)
- The Graph API key — [thegraph.com/studio/apikeys](https://thegraph.com/studio/apikeys/)
- Ethereum mainnet RPC URL, and a **dedicated low-balance EOA** for ENS purchases
- [Temporal CLI](https://docs.temporal.io/cli) for scheduled purchases (dev server)
- LLM / search keys for the reasoning layer
- 1inch credentials and x402 configuration when those land
- Optional: a public URL (e.g. ngrok) if Telegram uses webhooks

## 🔐 Environment

Copy [`.env.example`](./.env.example) to `.env`. Names only — fill values locally, never commit secrets.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP listen port (default `3000`) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot |
| `LITELLM_API_KEY` | Virtual key from the LiteLLM dashboard |
| `LITELLM_BASE_URL` | Proxy origin ending in `/v1` |
| `LITELLM_MODEL` | LiteLLM alias, e.g. `claude-haiku-4.5` or `claude-sonnet-4-6` |
| `TAVILY_API_KEY` | Search tool |
| `THEGRAPH_API_KEY` | ENS subgraph reads |
| `AGENT_TIMEZONE` | IANA zone the agent reports dates in (default: host zone) |
| 1inch / x402 vars | Add to `.env.example` when implemented |

ENS purchases spend real funds, so these four are the ones to get right:

| Variable | Purpose |
| --- | --- |
| `ETHEREUM_RPC_URL` | Mainnet RPC for quotes and transactions |
| `AGENT_PRIVATE_KEY` | Signer for commit/register. Dedicated EOA, never a personal wallet |
| `ENS_MAX_PURCHASE_ETH` | Hard ceiling for one registration, slippage included |
| `ENS_BUYER_ALLOWED_TELEGRAM_CHAT_IDS` | Comma-separated chat IDs allowed to spend those funds |

The allowlist is a single provider (`ENS_BUYER_CHAT_IDS`) shared by the purchase tool and both watch use cases. The LLM never decides who may spend.

Scheduled purchases add Temporal. The bot and the worker must agree on the last two:

| Variable | Purpose |
| --- | --- |
| `ENS_WATCH_SCHEDULER` | `memory` (default) or `temporal` |
| `TEMPORAL_ADDRESS` | Server address (default `127.0.0.1:7233`) |
| `TEMPORAL_NAMESPACE` | Namespace (default `default`) |
| `TEMPORAL_TASK_QUEUE` | Queue the worker polls (default `ens-drop`) |
| `TEMPORAL_TLS`, `TEMPORAL_API_KEY` | Temporal Cloud only |

Read env only from `bootstrap/` (or a tiny config helper called from bootstrap), not from `domain/` or `app/`.

## 🚀 Install & run

```bash
pnpm install

# watch
pnpm run start:dev

# once
pnpm run start

# compiled
pnpm run build && pnpm run start:prod
```

Health: `http://localhost:3000` (or `PORT`). If the UI also wants 3000, set `PORT=3001` here or run the UI on another port.

That is enough for chat, `lookup_ens` and `purchase_ens`. Scheduled purchases need two more processes.

### ⏳ Scheduled purchases (Temporal)

Install the CLI once, then put it on your `PATH` — the installer does not:

```bash
curl -sSf https://temporal.download/cli.sh | sh
echo 'export PATH="$PATH:$HOME/.temporalio/bin"' >> ~/.bashrc
source ~/.bashrc
```

Then run three terminals:

```bash
# 1. Temporal dev server (UI on http://localhost:8233)
temporal server start-dev

# 2. Worker — signs the purchase when the name drops
pnpm run start:worker

# 3. Bot
pnpm run start:dev
```

Check the server is up before starting the worker:

```bash
temporal operator cluster health   # expects SERVING
```

Inspect what is scheduled, from the CLI or the web UI at `localhost:8233`:

```bash
temporal workflow list
temporal workflow describe --workflow-id 'ens-drop:deficat'
```

Workflow IDs are `ens-drop:<label>`, so arming the same name twice is rejected by the server rather than tracked by us.

### 🧷 Default is not durable

`ENS_WATCH_SCHEDULER` defaults to `memory`, which **records watches and buys nothing**, and forgets everything on restart. It exists so the chat flow and the use cases run without a Temporal server.

Set `ENS_WATCH_SCHEDULER=temporal` for real watches. The choice is an env var and not a code edit because Nest instantiates providers eagerly: with Temporal hard-wired, the bot would refuse to boot whenever the server is down.

### 📋 Where scheduled watches live

Temporal is the only source of truth, so there is no second database to keep in sync. The adapter reads it on three levels:

| Channel | Carries | Survives completion |
| --- | --- | --- |
| `memo` | label, name, years, budget, requester, drop snapshot | yes |
| execution status | running, completed, cancelled, failed | yes |
| workflow query | current phase (`arming`, `committed`, …) | no |

`list_ens_watches` filters by requester on the memo, client-side. Filtering server-side would need a custom search attribute registered on the namespace, and a missing registration makes `start` fail outright — not worth the coupling at this scale.

Because a query only answers on a live execution, a finished watch reports its outcome from the workflow's return value (`bought` or `expired`) instead.

## 🎮 Run each platform

### 💬 Telegram

Bot: [t.me/DeFiCat_bot](https://t.me/DeFiCat_bot)

Telegraf launches from `TelegramInboundAdapter.onModuleInit`, so the bot listens as soon as `bot.ts` starts. Only `BotModule` registers that adapter: the worker shares the same Telegraf provider to *send* notifications, and must never register the inbound adapter, or two processes would long-poll the same token.

Ask for ENS data (`lookup_ens`), or a quote and a purchase (`purchase_ens`). A purchase needs the chat to be in `ENS_BUYER_ALLOWED_TELEGRAM_CHAT_IDS` **and** an exact confirmation phrase.

### 🤝 A2A

🚧 WIP (wave 3)

```bash
# placeholder — replace with the real A2A path
curl -i http://localhost:3000/a2a
```

### 💳 Payment (x402)

🚧 WIP (wave 2)

1. Call a gated service → expect **402** and payment instructions.
2. Complete payment in the [UI](../ui/README.md) (or the wallet flow the agent returns).
3. Retry the same service → Graph insight or 1inch result. 🎉

## 🧪 Tests

```bash
pnpm run test          # unit (Vitest)
pnpm run test:watch
pnpm run test:e2e
pnpm run test:cov
pnpm run lint
npx tsc --noEmit       # types only
```

Domain and use-case tests stay offline (fakes, no Nest testing module for core). Watch tests use `InMemoryEnsWatchScheduler`, so no Temporal server is needed.

The workflow is covered by `watchEnsDrop.e2e-spec.ts`, which runs under `pnpm test:e2e`. It uses the time-skipping test server, so a months-long sleep and the commit/reveal pair execute in milliseconds — the only place the spending path runs before it runs for real.

## 🔗 Related

- [UI](../ui/README.md) — SIWE and x402 payment screens
- [How Temporal works](../docs/TEMPORAL_TUTORIAL.md) — replay, activities, history limits, versioning
- [ENS purchase design](../docs/ENS_PURCHASE.md)
- [Hexagonal architecture](../docs/HEXAGONAL.md)
- [Security](../docs/SECURITY.md)
