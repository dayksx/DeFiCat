# DeFiCat UI

Next.js App Router app for **Sign-In with Ethereum**. Telegram sends the bind
link; this UI only connects a wallet and signs. The **agent** verifies the
signature and stores `telegram chatId ↔ Ethereum address`. After that, the
LLM already knows the linked wallet and when it was bound — this app does not
talk to the model.

## Routes

| Path | Role |
| --- | --- |
| `/` | Landing: go chat on Telegram to get a sign-in link. |
| `/siwe?token=…` | Connect wallet, sign EIP-4361, POST verify to the agent. |

Wagmi lives in `lib/wagmi.ts` (`ssr: true`, injected connector). Providers wrap
the tree in `src/app/layout.tsx`.

## Run locally

The agent HTTP API is on **3000**. Run this app on **3001** so SIWE `domain` /
`UI_ORIGIN` match (`localhost:3001`).

```bash
cd ui
cp .env.example .env   # or create ui/.env
pnpm install
pnpm run dev --port 3001
```

Do **not** write `pnpm run dev -- --port 3001`: Next treats `--port` as a
directory.

Open [http://localhost:3001](http://localhost:3001). The SIWE page is only
useful with a `token` from Telegram.

Also start the agent (`cd agents && pnpm run start:dev`) until logs show both
`Nest application successfully started` and `Telegram long polling started`.
If the bot process restarts, in-memory bind tokens die — ask Telegram for a
**new** link.

## Environment

`ui/.env`:

```bash
NEXT_PUBLIC_AGENTS_URL=http://localhost:3000
NEXT_PUBLIC_CHAIN_ID=1
```

`NEXT_PUBLIC_CHAIN_ID` must match agents `CHAIN_ID` (`1` mainnet, `11155111` Sepolia). Wagmi only exposes that chain so MetaMask is asked to switch. The SIWE **domain**, **statement**, and timestamps still come from `GET {AGENTS}/auth/siwe/challenge?token=` and must match `SIWE_DOMAIN` / `UI_ORIGIN` on the agent (no scheme on `SIWE_DOMAIN`).

## Sign-in flow

1. Unbound Telegram user gets a wall message with
   `{UI_ORIGIN}/siwe?token=<siwe-nonce>`.
2. `/siwe` loads the challenge, builds the same canonical message as the agent
   (`viem` `createSiweMessage` + checksum `getAddress`), and asks the wallet
   to sign. No gas, no funds moved.
3. `POST {AGENTS}/auth/siwe/verify` with `{ token, address, message, signature }`.
4. On success, go back to Telegram. The next message hits the LLM with the
   verified address and `boundAt`.

Tokens last **15 minutes**. A `401` on challenge/verify means the nonce expired
or the agent restarted — get a new link from the bot. Technical Nest errors go
to the browser console; the page shows a short bubble instead.

## Stack

Next 16, React 19, Tailwind 4, wagmi 3, viem, pnpm.
