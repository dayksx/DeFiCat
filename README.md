# 🐱 DeFiCat

Paid AI agents for onchain insights and DeFi operations: talk on Telegram or A2A, pay with x402, optionally authenticate and settle from the web UI. Insights come from **The Graph**; swaps and other DeFi actions go through **1inch**. Meow, then pay, then play. 😸

## 🎯 Problem & demo pitch

Real-time onchain data, in a decentralized way, is still hard to reach. Using that live data to actually do the right onchain move is even harder. DeFiCat lets you (or another agent) ask in Telegram or A2A, pay that one request with **x402**, and get the result: indexed data from **The Graph**, or a swap via **1inch**.

```text
User / peer agent
        │
        ├─ Telegram ──► Agents (NestJS) ──► The Graph (insights) 📊
        ├─ A2A     ──►        │          └── 1inch (DeFi ops) 🔄
        └─ Browser ──► UI (Next.js) ── SIWE + x402 payment 💳 ─┘
```

## ✨ Features

- 💬 Telegram agent ([t.me/DeFiCat_bot](https://t.me/DeFiCat_bot)) that sells services (insights and DeFi operations)
- 🤝 A2A agent that other agents can call with the same paid services
- 📊 Onchain insights via [The Graph](https://thegraph.com)
- 🔄 DeFi operations (swaps and related) via [1inch](https://1inch.io)
- 💳 x402 payment required before the service runs
- 🖥️ Web UI to pay for those services and to sign in with Ethereum (SIWE)

## 🏗️ Architecture

| Package | Stack | Role | README |
| --- | --- | --- | --- |
| [`agents/`](./agents) | NestJS, Node.js, TypeScript | Telegram + A2A, x402, The Graph, 1inch | [agents/README.md](./agents/README.md) |
| [`ui/`](./ui) | Next.js, React, TypeScript | Payment UI and SIWE wallet auth | [ui/README.md](./ui/README.md) |

Hexagonal layout and import rules: [docs/HEXAGONAL.md](./docs/HEXAGONAL.md). Security baseline: [docs/SECURITY.md](./docs/SECURITY.md).

## 📁 Repo layout

```text
.
├── agents/     # NestJS agents (Telegram, A2A, x402)
├── ui/         # Next.js payment + SIWE (scaffold)
└── docs/       # Architecture and security guidelines
```

## 🚀 Quick start (full stack)

**Prerequisites:** Node.js 20+, [pnpm](https://pnpm.io/installation) (`corepack enable` then `corepack prepare pnpm@latest --activate`).

Agents listen on `PORT` (default **3000**). Run the UI on another port (e.g. **3001**) so they do not collide.

```bash
# 1. Agents
cd agents
cp .env.example .env   # fill values — see agents/README.md
pnpm install
pnpm run start:dev

# 2. UI (in another terminal)
cd ui
cp .env.example .env   # fill values — see ui/README.md
pnpm install
pnpm run dev -- --port 3001
```

- 🤖 Agents: `http://localhost:3000`
- 🖥️ UI: `http://localhost:3001`

Per-service env vars and platform steps live in the package READMEs, not here.

## 🎬 Demo script (jury)

1. 💬 Message the Telegram bot at [t.me/DeFiCat_bot](https://t.me/DeFiCat_bot) (or call the A2A endpoint) asking for an insight (**The Graph**) or a DeFi operation (**1inch**).
2. 👛 Agent sends the connection link (Sign-In with Ethereum) or the payment link.
3. 💳 Follow the x402 payment flow in the UI.
4. 🎉 After payment, receive the insight or the DeFi result from the agent.

A2A URL and payment links will land here once those adapters are wired.

## 🧰 Tech stack (high level)

- 🤖 **Agents:** NestJS, TypeScript, Telegraf, LangChain / LangGraph, x402
- 📊 **Onchain insights:** [The Graph](https://thegraph.com)
- 🔄 **DeFi operations:** [1inch](https://1inch.io)
- 🖥️ **UI:** Next.js (App Router), React, TypeScript, SIWE, wallet connection
- 💳 **Payments:** HTTP 402 / x402 against agent services

## 🔐 Environment overview

Copy each package’s `.env.example`. Typical names (values stay in those files):

| Area | Examples |
| --- | --- |
| Agents | `PORT`, `TELEGRAM_BOT_TOKEN`, LLM keys, The Graph, 1inch, x402 |
| UI | `NEXT_PUBLIC_AGENTS_URL`, chain / SIWE / wallet connector keys |

## 🔗 Links

- [Agents](./agents/README.md)
- [UI](./ui/README.md)
- [Hexagonal architecture](./docs/HEXAGONAL.md)
- [Security](./docs/SECURITY.md)
