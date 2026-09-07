# 🤖 Agents

NestJS + Node.js + TypeScript. Agents that expose **onchain insights (The Graph)** and **DeFi operations (1inch)** and require an **x402 payment** before they run. No pay, no play. 😼

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
   x402, The Graph, 1inch, LLM, Telegram API  (infrastructure/)
```

Nest (`bootstrap/`) wires adapters. `@nestjs/*` does not enter `domain/` or `app/`. See [docs/HEXAGONAL.md](../docs/HEXAGONAL.md).

## ✨ Features

| Surface | What it does | Status |
| --- | --- | --- |
| 💬 Telegram bot | Conversation, service request, payment prompt | Planned (Telegraf is a dependency) |
| 🤝 A2A | Other agents discover and call the same paid services | Planned |
| 💳 x402 | Service returns 402 until paid, then runs | Planned |
| 📊 Onchain insights | Indexed chain data via [The Graph](https://thegraph.com) | Planned |
| 🔄 DeFi operations | Swaps and related actions via [1inch](https://1inch.io) | Planned |
| ❤️ HTTP health | Process listens (`PORT`, default 3000) | Scaffold (`bootstrap/`) |

## 🏗️ Architecture (this package)

Intended layout (hexagon). Only `domain/` and `bootstrap/` exist today.

```text
src/
  domain/           # invariants, value objects — no I/O
  app/              # use cases + ports (to add)
  infrastructure/   # Telegram, A2A, x402, The Graph, 1inch, LLM (to add)
  bootstrap/        # AppModule, main.ts — composition root
```

## ✅ Prerequisites

- Node.js 20+
- pnpm (this package pins `packageManager` in `package.json`)
- Telegram bot token (BotFather) when enabling the bot
- The Graph API / subgraph access when enabling insights
- 1inch API credentials when enabling DeFi operations
- LLM / search keys when enabling the reasoning layer
- x402 configuration when enabling payments
- Optional: a public URL (e.g. ngrok) if Telegram uses webhooks

## 🔐 Environment

Copy [`.env.example`](./.env.example) to `.env`. Names only — fill values locally, never commit secrets.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP listen port (default `3000`) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot |
| `OPENAI_API_KEY` | LLM (LangChain) — confirm name when wiring config |
| `TAVILY_API_KEY` | Search tool, if used |
| The Graph vars | Gateway / subgraph URL — add to `.env.example` when implemented |
| 1inch vars | API key / base URL — add to `.env.example` when implemented |
| x402 vars | Payment gate — add to `.env.example` when implemented |

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

## 🎮 Run each platform

### 💬 Telegram

Bot: [t.me/DeFiCat_bot](https://t.me/DeFiCat_bot)

🚧 WIP (wave 1)

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
```

Domain and use-case tests stay offline (fakes, no Nest testing module for core).

## 🔗 Related

- [UI](../ui/README.md) — SIWE and x402 payment screens
- [Hexagonal architecture](../docs/HEXAGONAL.md)
- [Security](../docs/SECURITY.md)
