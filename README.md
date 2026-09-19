# 🐱 DeFiCat

**ETHGlobal Online 2026** — prize tracks: **[The Graph](https://thegraph.com)** and **[ENS](https://ens.domains)**.

Telegram agent that **looks up** ENS names with The Graph, then **buys** them (now or when they drop) after an **x402** payment. Names like `kikoulol.eth` and subnames like `degen.kikoulol.eth`. Meow, pay, register. 😸

A later wave (not in this demo) is paid DeFi services on the same rails.

## 🎯 Problem & demo pitch

ENS data is public, but acting on it from chat is still clunky: is `kikoulol.eth` free, who owns it, when does it expire, can I buy it, can I sit on a taken name until it drops?

DeFiCat answers that in Telegram. **The Graph** is the read path (owner, expiry, grace). **ENS** is the write path (register now, or arm a Temporal watch). **x402** is the gate: 0.01 USDC to buy now, 0.1 USDC to schedule the drop buy. The agent spends its own ETH on mainnet; the user pays the service fee in USDC on Base Sepolia.

```text
User
  ├─ Telegram ──► Agents (NestJS)
  │                 ├─ The Graph  → lookup (2LD + subnames)
  │                 ├─ ENS        → buy now / buy on drop
  │                 └─ Temporal   → durable watch until expiry
  ├─ Other agents ──► A2A HTTP (x402 on buy / schedule)
  └─ Browser ──► UI (Next.js) ── SIWE + x402 ──► Agents
```

## ✨ Features

| Feature | What it does | Status |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------- |
| 💬 Telegram bot | Chat at [t.me/DeFiCat_bot](https://t.me/DeFiCat_bot) | ✅ |
| 📊 ENS lookup | Owner, expiry, grace via [The Graph](https://thegraph.com) — `kikoulol.eth`, `degen.kikoulol.eth`, or an address | ✅ |
| 🛒 Buy now | Quote + commit/reveal for an available **2LD** `.eth`, after **0.01 USDC** x402 (`ens.buy.now`) | ✅ / in progress |
| ⏳ Schedule buy | Watch a taken name and buy when it drops, after **0.1 USDC** x402 (`ens.watch.arm`) | ✅ / in progress |
| 👛 SIWE | Bind Telegram chat ↔ wallet in the UI | ✅ |
| 💳 x402 | Pay the SKU, then the agent auto-runs the buy or arms the watch | in progress |
| 🧩 Subname registration | Create a subname such as `me.kikoulol.eth` under an agent-owned wrapped parent | ✅ |
| 🔄 DeFi services | Swaps / other paid ops on the same x402 catalogue | **not in this demo** |
| 🤝 A2A | Other agents call the same paid ENS services over HTTP + x402 | ✅ |

Lookups stay free. Telegram spends still need an allowlisted chat, an exact confirmation phrase, and a successful x402 receipt. Other agents use the A2A endpoints: free insight, 0.01 USDC to buy, 0.1 USDC to schedule.

## 🏆 Hackathon

Built for **ETHGlobal Online 2026**.

| Track | How we use it |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| **The Graph** | ENS subgraph reads: availability, owner, expiry, grace period — including subnames that have no registrar row |
| **ENS** | Register `.eth` 2LDs from chat; watch drops; product goal includes subnames |

## 🏗️ Architecture

| Package | Stack | Role | README |
| --------------------- | ------------------ | ---------------------------------------- | -------------------------------------- |
| [`agents/`](./agents) | NestJS, TypeScript | Telegram, ENS, The Graph, Temporal, x402 | [agents/README.md](./agents/README.md) |
| [`ui/`](./ui) | Next.js, React | SIWE + x402 payment pages | [ui/README.md](./ui/README.md) |

Hexagonal layout: [docs/HEXAGONAL.md](./docs/HEXAGONAL.md). Security: [docs/SECURITY.md](./docs/SECURITY.md). Docs index: [docs/README.md](./docs/README.md).

## 📁 Repo layout

```text
.
├── agents/     # NestJS bot + Temporal worker
├── ui/         # Next.js SIWE + pay
└── docs/       # Architecture, ENS, x402, Temporal
```

## 🚀 Quick start (full stack)

**Prerequisites:** Node.js 20+, [pnpm](https://pnpm.io/installation) (`corepack enable` then `corepack prepare pnpm@latest --activate`).

Agents listen on `PORT` (default **3000**). Run the UI on **3001**.

```bash
# 1. Agents
cd agents
cp .env.example .env   # fill values — see agents/README.md
pnpm install
pnpm run start:dev

# 2. UI (another terminal)
cd ui
cp .env.example .env   # fill values — see ui/README.md
pnpm install
pnpm run dev --port 3001
```

- 🤖 Agents: `http://localhost:3000`
- 🖥️ UI: `http://localhost:3001`

Scheduled buys need a Temporal server and a worker. Steps: [agents/README.md](./agents/README.md#-scheduled-purchases-temporal).

## 🎬 Demo script (jury)

1. Open [t.me/DeFiCat_bot](https://t.me/DeFiCat_bot). Bind the wallet via the SIWE link if asked.
2. **Lookup:** “Who owns `kikoulol.eth`?” / “Is `degen.kikoulol.eth` taken?” → The Graph.
3. **Buy now** (name available, chat allowlisted): confirm the phrase → pay **0.01 USDC** (x402) in the UI → agent registers the 2LD.
4. **Schedule buy** (name taken or over budget): confirm the watch phrase → pay **0.1 USDC** → Temporal waits for the drop and buys within budget.

DeFi (swaps, DCA, …) is explicitly out of this demo.

## 🧰 Tech stack (high level)

- 🤖 **Agents:** NestJS, TypeScript, Telegraf, LangGraph
- 📊 **Reads:** [The Graph](https://thegraph.com) ENS subgraph
- 🛒 **Writes:** [viem](https://viem.sh) → ETHRegistrarController (mainnet)
- ⏳ **Watches:** [Temporal](https://temporal.io)
- 🖥️ **UI:** Next.js, wagmi, SIWE
- 💳 **Payments:** x402 (`exact`, USDC on Base Sepolia)

## 🔐 Environment overview

Copy each package’s `.env.example`. Typical names (values stay in those files):

| Area | Examples |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Agents | `PORT`, `TELEGRAM_BOT_TOKEN`, LLM keys, `THEGRAPH_API_KEY` |
| ENS purchases | `ETHEREUM_RPC_URL`, `AGENT_PRIVATE_KEY`, `ENS_MAX_PURCHASE_ETH`, `ENS_BUYER_ALLOWED_TELEGRAM_CHAT_IDS` |
| Temporal | `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE` |
| x402 | `X402_PAY_TO`, `X402_FACILITATOR_URL` (USDC Base Sepolia; ENS stays on `CHAIN_ID`) |
| UI | `NEXT_PUBLIC_AGENTS_URL`, `NEXT_PUBLIC_CHAIN_ID` |

## 🔗 Links

- [Agents](./agents/README.md)
- [UI](./ui/README.md)
- [Docs index](./docs/README.md)
- [ENS purchase](./docs/ENS_PURCHASE.md)
- [x402 + Telegram](./docs/X402_TELEGRAM.md)
- [Hexagonal architecture](./docs/HEXAGONAL.md)
- [Security](./docs/SECURITY.md)
