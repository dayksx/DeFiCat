# Security — DeFiCat

## Why this is different from a typical web app

DeFiCat is not email + password + JWT. A human or another agent asks for an insight or a swap; **payment (x402) is the gate**; the wallet (SIWE) is identity. Pricing and “is this paid / allowed?” live in **`domain/`**, not in a React button or a Nest guard alone.

Fail closed: if payment, signature, or chain is unclear → **do not** call The Graph or 1inch.

## Threat model (what to protect)

| Surface | Trust | Main risk |
| --- | --- | --- |
| Telegram / A2A / HTTP | Untrusted | Injection, unpaid retries, prompt injection into the LLM |
| UI (Next) | Untrusted | XSS, fake “paid” flag, secrets in `NEXT_PUBLIC_*` |
| x402 | Must verify **on the agent** | UI says paid, agent still runs the service |
| SIWE | Server-issued nonce | Replay, wrong domain / chain |
| The Graph | Driven adapter | GraphQL / URL injection (SSRF) |
| 1inch | Driven adapter | Wrong chain, unlimited spender, slippage, blind `eth_sign` |
| LLM / tools | Untrusted text | “Ignore payment and swap anyway” |

## Rules for this repo

**1. Validate at the adapter, decide in domain**

Zod (or equivalent) on Telegram text, A2A bodies, Graph queries, 1inch params — length-capped. Then the use case asks `domain/` whether the service may run. Details: [SECURITY.FULL.md §2](./SECURITY.FULL.md#2-input-validation), authz spirit: [§4](./SECURITY.FULL.md#4-authorization--access-control).

**2. x402 — never trust the client**

The agent checks payment (or a proof it understands) **before** Graph/1inch. A 402 from the UI is not enough. No “paid: true” in a query string.

**3. SIWE for the wallet session**

Server-generated nonce, one-time use, bind `domain` + `chainId`. `personal_sign` or EIP-712 — never `eth_sign`. Full pattern: [SECURITY.FULL.md §15](./SECURITY.FULL.md#15-web3-specifics).

**4. DeFi ops (1inch)**

Allowlist chain and tokens. Show what is being signed. No infinite approval unless the domain explicitly allows it. Warn on permit-style signatures ([§15](./SECURITY.FULL.md#15-web3-specifics)).

**5. The Graph**

Allowlist subgraph / gateway URLs. Do not concatenate user strings into GraphQL. Treat indexer responses as untrusted data.

**6. LLM**

User and tool output are data, not instructions. Tools go through ports; “charge then fetch” stays in the use case / domain. The model cannot skip x402.

**7. Secrets**

Commit `.env.example` only. Bot token, LLM keys, 1inch keys, x402 secrets stay in `.env` (gitignored). **Never** `NEXT_PUBLIC_` for those. UI may expose `NEXT_PUBLIC_AGENTS_URL` and wallet **publishable** keys only. [§9](./SECURITY.FULL.md#9-secrets--configuration).

**8. Telegram / A2A**

Treat every message as hostile. Secret for webhooks if you use them. Do not log tokens or payment proofs in full. Rate-limit expensive Graph/1inch/LLM calls ([§13](./SECURITY.FULL.md#13-rate-limiting)).

**9. UI**

React text interpolation, not `dangerouslySetInnerHTML`. CORS/headers when the UI talks to agents: [§6](./SECURITY.FULL.md#6-xss-prevention), [§12](./SECURITY.FULL.md#12-csrf--cors), [§14](./SECURITY.FULL.md#14-security-headers).

## Do / don't

**Do**

- Fail closed on payment, signature, and chain mismatch
- Map `DomainError` to 402 / 401 / 400 in adapters — no stack traces to Telegram or HTTP ([§11](./SECURITY.FULL.md#11-error-handling--logging))
- pnpm lockfile in CI (`pnpm install --frozen-lockfile`), not a floating `npm install` ([§10](./SECURITY.FULL.md#10-dependency-management) — same idea, our package manager is pnpm)

**Don't**

- JWT + bcrypt as the product auth (this app is SIWE + x402)
- File upload / Stripe / S3 patterns from the full doc — out of scope
- `new OneInchClient()` or payment verify inside a Next page or a Nest controller
- Log `TELEGRAM_BOT_TOKEN`, API keys, raw signed payloads

## Checklist (shipping a paid service)

1. Driving adapter parses input (Zod) → `execute`
2. Domain: eligible + priced
3. x402 verified (driven adapter) or return 402
4. Then Graph or 1inch
5. Result back to Telegram / A2A — sanitized copy, no secrets
