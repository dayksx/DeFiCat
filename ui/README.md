# 🖥️ DeFiCat UI

Next.js App Router app for **ETHGlobal Online 2026** (**The Graph** + **ENS**). Telegram sends a link; this UI **binds a wallet (SIWE)** and **pays x402** for ENS buy-now / schedule-buy. The **agent** verifies everything. This app does not talk to the model, The Graph, or the ENS registrar.

Product context: [../README.md](../README.md).

## 🐱 Role

```text
Wallet 👛
    │
    ▼
Next.js UI  ── SIWE / pay ──►  Agents (x402 + ENS)
    ▲
    └── deep link from Telegram 💬
```

Pricing, allowlists, and registration live in [`agents/`](../agents/README.md).

## Routes

| Path | Role | Status |
| --- | --- | --- |
| `/` | Landing: go chat on Telegram to get a sign-in or pay link | ✅ |
| `/siwe?token=…` | Connect wallet, sign EIP-4361, POST verify to the agent | ✅ |
| `/pay?token=…` | Complete x402 v2 for `ens.buy.now`, `ens.subname.create` (0.01 USDC), or `ens.watch.arm` (0.1 USDC) | ✅ |

Wagmi lives in `lib/wagmi.ts` (`ssr: true`, injected connector). Providers wrap the tree in `src/app/layout.tsx`.

## Run locally

The agent HTTP API is on **3000**. Run this app on **3001** so SIWE `domain` / `UI_ORIGIN` match (`localhost:3001`).

```bash
cd ui
cp .env.example .env
pnpm install
pnpm run dev --port 3001
```

Do **not** write `pnpm run dev -- --port 3001`: Next treats `--port` as a directory.

Open [http://localhost:3001](http://localhost:3001). SIWE and pay pages need a `token` from Telegram.

Also start the agent (`cd agents && pnpm run start:dev`) until logs show both `Nest application successfully started` and `Telegram long polling started`. If the bot process restarts, in-memory tokens die — ask Telegram for a **new** link.

## Environment

`ui/.env`:

```bash
NEXT_PUBLIC_AGENTS_URL=http://localhost:3000
NEXT_PUBLIC_CHAIN_ID=1
NEXT_PUBLIC_PAYMENT_CHAIN_ID=84532
```

`NEXT_PUBLIC_CHAIN_ID` must match agents `CHAIN_ID` (`1` mainnet, `11155111` Sepolia) for SIWE. `NEXT_PUBLIC_PAYMENT_CHAIN_ID=84532` selects Base Sepolia for x402. The UI uses `@x402/core` + `@x402/evm` to sign an EIP-3009 USDC authorization; the agent sends it to the facilitator for settlement.

The SIWE **domain**, **statement**, and timestamps still come from `GET {AGENTS}/auth/siwe/challenge?token=` and must match `SIWE_DOMAIN` / `UI_ORIGIN` on the agent (no scheme on `SIWE_DOMAIN`).

Never put bot tokens or LLM keys in the UI.

## Flows

### Sign-in (SIWE)

1. Unbound Telegram user gets `{UI_ORIGIN}/siwe?token=<siwe-nonce>`.
2. `/siwe` loads the challenge, builds the same canonical message as the agent (`viem` `createSiweMessage` + checksum `getAddress`), and asks the wallet to sign. No gas, no funds moved.
3. `POST {AGENTS}/auth/siwe/verify` with `{ token, address, message, signature }`.
4. Back to Telegram. The next message hits the LLM with the verified address.

Tokens last **15 minutes**. A `401` means the nonce expired or the agent restarted — get a new link from the bot.

### Pay (x402)

1. Confirm **buy now** or **schedule buy** in Telegram.
2. Open `{UI_ORIGIN}/pay?token=<payment-session>`.
3. Sign the USDC (EIP-3009) payment the agent described.
4. UI `POST {AGENTS}/pay/x402/settle`. The agent settles, then registers the name or arms the Temporal watch.

See [docs/X402_TELEGRAM.md](../docs/X402_TELEGRAM.md).

## Stack

Next 16, React 19, Tailwind 4, wagmi 3, viem, pnpm.

## 🔗 Related

- [Root overview](../README.md)
- [Agents](../agents/README.md)
- [x402 + Telegram](../docs/X402_TELEGRAM.md)
- [SIWE + Telegram](../docs/SIWE_TELEGRAM.md)
- [Hexagonal architecture](../docs/HEXAGONAL.md)
- [Security](../docs/SECURITY.md)
