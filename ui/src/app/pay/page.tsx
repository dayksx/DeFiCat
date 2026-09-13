"use client";

import { getAddress } from "viem";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAccount, useConnect, useSwitchChain } from "wagmi";
import { baseSepolia } from "wagmi/chains";

const AGENTS = process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3000";
const NEW_LINK = "please chat to DeFiCat to get a new payment link";

export default function PayPage() {
  return (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-zinc-400">Loading…</div>}>
      <PayForm />
    </Suspense>
  );
}

function PayForm() {
  const token = useSearchParams().get("token") ?? "";
  const { address, isConnected, chainId } = useAccount();
  const { connectAsync, connectors, isPending: connecting } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paid, setPaid] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => setMounted(true), []);

  async function onPay() {
    if (!token || !address || busy) return;
    setBusy(true);
    try {
      if (chainId !== baseSepolia.id) {
        await switchChainAsync({ chainId: baseSepolia.id });
      }
      const res = await fetch(
        `${AGENTS}/pay/x402?token=${encodeURIComponent(token)}`,
      );
      if (res.status === 401) {
        setStatus(`Sign-in / pay link timed out, ${NEW_LINK}`);
        return;
      }
      if (res.status !== 402) {
        setStatus(`DeFiCat could not quote that, ${NEW_LINK}`);
        return;
      }
      const requirements = await res.json();
      if (getAddress(address) !== getAddress(requirements.payer)) {
        setStatus("Reconnect the wallet linked to Telegram.");
        return;
      }
      // TODO: build + sign the x402 payload from `requirements` (EIP-3009).
      const payload = { /* signed payment */ };
      const settle = await fetch(`${AGENTS}/pay/x402/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: requirements.nonce, payload }),
      });
      if (!settle.ok) {
        setStatus(`DeFiCat could not verify that, ${NEW_LINK}`);
        return;
      }
      setPaid(true);
      setStatus("Paid. Head back to Telegram — DeFiCat is running the job.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm text-center">
        <h1 className="mt-6 text-3xl font-black tracking-tight text-[#2AABEE]">DeFiCat</h1>
        <p className="mt-2 text-sm text-zinc-500">Pay USDC on Base Sepolia. No ENS gas from you.</p>
        {!token ? (
          <p className="mt-7 text-sm">This link has no token, {NEW_LINK}</p>
        ) : (
          <button
            type="button"
            disabled={mounted ? busy || paid : undefined}
            onClick={() => {
              if (!isConnected) {
                const c = connectors[0];
                if (c) void connectAsync({ connector: c });
                return;
              }
              void onPay();
            }}
            className="mt-8 h-12 w-full rounded-full bg-[#2AABEE] text-sm font-bold text-white"
          >
            {paid ? "Paid 😽" : connecting ? "Connecting…" : isConnected ? "Pay with USDC 🚀" : "Connect wallet 🔌"}
          </button>
        )}
        {status ? <p className="mt-6 text-sm text-zinc-600">{status}</p> : null}
      </div>
    </div>
  );
}