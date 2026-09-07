# 🖥️ UI

Next.js (React, TypeScript). Front-end to **pay for agent services** (x402) and to **authenticate with a wallet** (Sign-In with Ethereum). The shiny side of the cat. 😺

Product context: [../README.md](../README.md).

## 🐱 Role in DeFiCat

Humans land here when an agent asks for payment or when they need a session bound to an Ethereum address. Policy, pricing, **The Graph** insights, and **1inch** DeFi operations stay in [`agents/`](../agents/README.md). This app renders flows and talks to wallets + the agents HTTP API.

```text
Wallet (SIWE) 👛
    │
    ▼
Next.js UI  ──pay / session──►  Agents (x402 + services)
    ▲
    └── deep link / QR from Telegram or A2A 💬
```

## ✨ Features

| Feature | What it does | Status |
| --- | --- | --- |
| 👛 Sign-In with Ethereum | Connect wallet, sign, session | Planned |
| 💳 Pay for an agent service | Complete x402 after Telegram / A2A | Planned |
| 🧾 Connect / pay / receipt screens | Status of payment and return path to the agent | Planned |

This folder is the intended Next.js app; scaffold it with `create-next-app` (or the team template) before the commands below will work.

## 🧰 Stack

- Next.js (App Router), React, TypeScript
- Wallet + SIWE (library TBD: e.g. wagmi / RainbowKit / Dynamic)
- Client for the agents base URL (`NEXT_PUBLIC_AGENTS_URL`)

Follow [docs/HEXAGONAL.md](../docs/HEXAGONAL.md) for the UI package: pages and hooks render view-models; they do not encode pricing or eligibility rules. Secrets, SIWE, XSS: [docs/SECURITY.md](../docs/SECURITY.md).

## ✅ Prerequisites

- Node.js 20+, pnpm
- Agents running locally or a remote agents URL
- Wallet connector project keys when you enable SIWE
- A funded test wallet on the chain you use for x402

## 🔐 Environment

Create `.env.example` next to this README when the app is scaffolded, then copy to `.env.local`.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_AGENTS_URL` | Agents origin, e.g. `http://localhost:3000` |
| Chain / SIWE vars | Chain id, SIWE domain/URI |
| Wallet connector keys | WalletConnect, Dynamic, or equivalent — public keys only in `NEXT_PUBLIC_*` |

Never put bot tokens or LLM keys in the UI. 🤫

## 🚀 Install & run

Agents default to port **3000**. Run this app on **3001** unless you change `PORT` on the agents side.

```bash
pnpm install
pnpm run dev -- --port 3001
```

- 🖥️ Local UI: `http://localhost:3001`
- 🏭 Production-style: `pnpm run build && pnpm run start` (adjust when `package.json` exists)

## 🎮 Flows

### 1. 👛 Wallet auth (SIWE)

1. Open the UI and connect a wallet.
2. Sign the SIWE message.
3. Session is established; the UI can show address / chain.

Wire the exact routes here (`/`, `/login`, …) when they exist.

### 2. 💳 Pay for an agent service

1. Request a paid insight from Telegram or A2A; copy the payment link (or QR) into the UI.
2. Confirm network and amount; submit the x402 payment.
3. Show success / receipt; retry or return to the agent so the service can run. 🎉

## 📁 Project structure

Target once Next.js is added:

```text
ui/
  app/           # routes (connect, pay, receipt)
  components/
  lib/           # SIWE, wallet, agents/x402 client
  .env.example
```

## 🔗 Related

- [Root overview](../README.md)
- [Agents](../agents/README.md)
- [Hexagonal architecture](../docs/HEXAGONAL.md)
- [Security](../docs/SECURITY.md) · [full](../docs/SECURITY.FULL.md)
