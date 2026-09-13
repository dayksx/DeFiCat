# 🤖 Agents

NestJS + Node.js + TypeScript. Telegram agent for **ETHGlobal Online 2026** (**The Graph** + **ENS** tracks): look up names, **buy now** or **schedule a buy**, after **x402**. No pay, no register. 😼

Product context: [../README.md](../README.md).

## 🐱 Role in DeFiCat

This process is the composition root. Telegram talks; The Graph reads; viem writes ENS; Temporal holds drop watches; x402 gates the two paid SKUs. The UI only binds wallets (SIWE) and completes payment.

```text
Telegram / HTTP
        │  driving adapters
        ▼
   use cases (app/)  →  domain (ENS policy, payment policy)
        │  ports
        ▼
   x402, The Graph, ENS (viem), Temporal, LLM, Telegram API
```

Nest (`bootstrap/`) wires adapters. `@nestjs/*` does not enter `domain/` or `app/`. See [docs/HEXAGONAL.md](../docs/HEXAGONAL.md).

**v1 catalogue**

| SKU | Price | After payment |
| -------------------- | --------- | -------------------------------------------------------------- |
| `ens.buy.now` | 0.01 USDC | Run `purchase_ens` (available 2LD `.eth`) |
| `ens.subname.create` | 0.01 USDC | Run `purchase_ens_subname` under an agent-owned wrapped parent |
| `ens.watch.arm` | 0.1 USDC | Arm Temporal watch (taken / over budget) |

`lookup_ens`, quotes, and `list_ens_watches` stay free. DeFi SKUs are a later wave, not this demo.

Names in the pitch: **2LD** `kikoulol.eth` (buy/watch) and **subnames** `degen.kikoulol.eth` (lookup/create).

## ⚠️ Two processes, not one

A scheduled ENS purchase can wait for months, so it cannot live in the bot's memory. The package ships **two entrypoints** that share adapters through `EnsCoreModule`.

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

The bot only **arms and cancels** watches. The purchase itself is signed later by the worker. Both load `AGENT_PRIVATE_KEY`; run **a single worker** in production (one EOA, one nonce).

## ✨ Features

| Surface | What it does | Status |
| ---------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| 💬 Telegram bot | LangGraph, ENS tools, web search | ✅ |
| 📊 ENS insights | Owner, expiry, grace via [The Graph](https://thegraph.com) — 2LD and subnames | ✅ `lookup_ens` |
| 🛒 Buy now | Quote then commit/reveal, allowlist + budget cap | ✅ `purchase_ens` |
| ⏳ Schedule buy | Buy a taken 2LD the moment it drops, within budget | ✅ `schedule_ens`, `list_ens_watches`, `cancel_ens_watch` |
| 💳 x402 | 402 + settle, then auto-run buy or arm watch | in progress |
| 🧩 Subname mint | Create `degen.kikoulol.eth` under an agent-owned wrapped parent | ✅ `purchase_ens_subname` |
| 🔄 DeFi services | Same payment rails, different SKUs | **not this demo** |
| 🤝 A2A | Other agents, same paid ENS services over HTTP + x402 | ✅ `/a2a` |
| ❤️ HTTP health | `PORT`, default 3000 | ✅ |

`schedule_ens` is offered when a quote has `schedulable=true` (taken or above budget). Arming a watch needs the exact confirmation phrase: the later purchase does not ask again.

## 🏗️ Architecture (this package)

```text
src/
  domain/                    # invariants — no I/O
    ens/                     # EnsPurchasePolicy, EnsDropWatch
    billing/                 # PaymentPolicy, ServiceCatalog, sessions
  app/
    ports/                   # conversation, ens, graph, messaging, watch, billing
    use-cases/               # HandleIncomingMessage, PurchaseEnsName,
                             #   EnsWatch, Billing (issue / settle / fulfill)
  infrastructure/adapters/
    telegram/ langgraph/
    thegraph/ ens/           # reads (The Graph) and writes (viem)
    temporal/                # workflow, activities, scheduler
    x402/ http/              # facilitator + /pay/x402
    watch/                   # in-memory scheduler (dev / tests)
  bootstrap/
    EnsCoreModule.ts
    BotModule.ts  bot.ts
    WorkerModule.ts worker.ts
```

## ✅ Prerequisites

- Node.js 20+
- pnpm (this package pins `packageManager` in `package.json`)
- Telegram bot token (BotFather)
- The Graph API key — [thegraph.com/studio/apikeys](https://thegraph.com/studio/apikeys/)
- Ethereum RPC for **the same chain as `CHAIN_ID`** (mainnet by default) and a **dedicated low-balance EOA** for ENS purchases
- [Temporal CLI](https://docs.temporal.io/cli) for scheduled purchases
- LLM / search keys
- x402: USDC on Base Sepolia + facilitator URL
- Optional: a public URL (e.g. ngrok) if Telegram uses webhooks

## 🔐 Environment

Copy [`.env.example`](./.env.example) to `.env`. Names only — fill values locally, never commit secrets.

| Variable | Purpose |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT` | HTTP listen port (default `3000`) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot |
| `TELEGRAM_HANDLER_TIMEOUT_MS` | Max time one update may run (default `900000`). Must exceed an ENS buy (~2 min) |
| `LITELLM_API_KEY` | Virtual key from the LiteLLM dashboard |
| `LITELLM_BASE_URL` | Proxy origin ending in `/v1` |
| `LITELLM_MODEL` | LiteLLM alias, e.g. `claude-haiku-4.5` or `claude-sonnet-4-6` |
| `TAVILY_API_KEY` | Search tool |
| `CHAIN_ID` | `1` mainnet (default). SIWE + ENS follow this. Sepolia (`11155111`) can look up and quote but **cannot register**: ENS revoked its v1 controllers there |
| `THEGRAPH_API_KEY` | ENS subgraph reads |
| `AGENT_TIMEZONE` | IANA zone the agent reports dates in (default: host zone) |
| `UI_ORIGIN` / `SIWE_DOMAIN` | Wallet bind UI |

ENS purchases spend real funds:

| Variable | Purpose |
| ------------------------------------- | ------------------------------------------------------------------ |
| `ETHEREUM_RPC_URL` | RPC for `CHAIN_ID` (quotes and transactions) |
| `ENS_REGISTRAR_CONTROLLER` | Optional override of the preset registrar |
| `ENS_PUBLIC_RESOLVER` | Optional override of the preset resolver |
| `ENS_SUBGRAPH_ID` | Optional override of The Graph subgraph id |
| `AGENT_PRIVATE_KEY` | Signer for commit/register. Dedicated EOA, never a personal wallet |
| `ENS_MAX_PURCHASE_ETH` | Hard ceiling for one registration, slippage included |
| `ENS_BUYER_ALLOWED_TELEGRAM_CHAT_IDS` | Comma-separated chat IDs allowed to spend those funds |

The allowlist is a single provider (`ENS_BUYER_CHAT_IDS`) shared by the purchase tool and both watch use cases. The LLM never decides who may spend.

x402 is a **different chain** from ENS:

| Variable | Purpose |
| ---------------------- | ---------------------------------------------------- |
| `X402_PAY_TO` | Treasury (same EOA as `AGENT_PRIVATE_KEY`, checksum) |
| `X402_FACILITATOR_URL` | Default `https://x402.org/facilitator` |

Scheduled purchases add Temporal. The bot and the worker must agree on the last two:

| Variable | Purpose |
| ---------------------------------- | ------------------------------------------- |
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
| ---------------- | ---------------------------------------------------- | ------------------- |
| `memo` | label, name, years, budget, requester, drop snapshot | yes |
| execution status | running, completed, cancelled, failed | yes |
| workflow query | current phase (`arming`, `committed`, …) | no |

`list_ens_watches` filters by requester on the memo, client-side. Filtering server-side would need a custom search attribute registered on the namespace, and a missing registration makes `start` fail outright — not worth the coupling at this scale.

Because a query only answers on a live execution, a finished watch reports its outcome from the workflow's return value (`bought` or `expired`) instead.

## 🎮 Run each platform

### 💬 Telegram

Bot: [t.me/DeFiCat_bot](https://t.me/DeFiCat_bot)

Telegraf launches from `TelegramInboundAdapter.onModuleInit`, so the bot listens as soon as `bot.ts` starts. Only `BotModule` registers that adapter: the worker shares the same Telegraf provider to _send_ notifications, and must never register the inbound adapter, or two processes would long-poll the same token.

Ask for ENS data (`lookup_ens`), or a quote and a purchase (`purchase_ens`). A purchase needs the chat to be in `ENS_BUYER_ALLOWED_TELEGRAM_CHAT_IDS`, an exact confirmation phrase, and a settled x402 payment for `ens.buy.now` (or `ens.watch.arm` for a scheduled buy).

### 💳 Payment (x402)

ENS registration is on **mainnet**. The service fee is **USDC on Base Sepolia**.

1. Confirm buy or watch in Telegram → agent issues a payment session (token + UI link).
2. UI / wallet completes x402 (`GET /pay/x402?token=…` then `POST /pay/x402/settle`).
3. Agent verifies + settles via the facilitator, then **auto-runs** the paid intent (register now, or arm the watch).

Details: [docs/X402_TELEGRAM.md](../docs/X402_TELEGRAM.md).

### 🤝 A2A

Other agents call the same ENS skills over HTTP. Discover them at `GET /.well-known/agent-card.json`.

| Skill | Method | Price |
| --- | --- | --- |
| Insight (The Graph lookup + 2LD quote) | `GET /a2a/ens/insight?name=vitalik.eth` | free |
| Buy an available 2LD | `POST /a2a/ens/buy` `{ "name": "kikoulol.eth", "years": 1 }` | **0.01 USDC** x402 |
| Schedule a drop buy | `POST /a2a/ens/schedule` `{ "name": "takenname.eth", "years": 1 }` | **0.1 USDC** x402 |

Paid routes return `402` + `PAYMENT-REQUIRED` until the caller retries with `PAYMENT-SIGNATURE` (x402 v2 `exact` on Base Sepolia). Settlement then **waits** for the ENS job (register now, or arm the Temporal watch) and returns the result in the JSON body. Callers do not need SIWE or a Telegram chat.

An x402 client such as `@x402/fetch` `wrapFetchWithPayment` can pay the 402 automatically. Cap spend at 0.1 USDC so the agent cannot overpay.

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
- [How Temporal works](../docs/TEMPORAL_TUTORIAL.md)
- [ENS purchase design](../docs/ENS_PURCHASE.md)
- [x402 + Telegram](../docs/X402_TELEGRAM.md)
- [Hexagonal architecture](../docs/HEXAGONAL.md)
- [Security](../docs/SECURITY.md)
