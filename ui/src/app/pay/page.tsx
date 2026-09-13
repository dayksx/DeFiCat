"use client";

import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { ClientEvmSigner } from "@x402/evm";
import { getAddress } from "viem";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import {
  useAccount,
  useConnect,
  useSwitchChain,
  useWalletClient,
} from "wagmi";
import { paymentChain } from "../../../lib/wagmi";

const AGENTS = process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3000";
const NEW_LINK = "please chat to DeFiCat to get a new payment link";
const PAYMENT_NETWORK = `eip155:${paymentChain.id}` as const;

type RequirementsResponse = {
  paymentRequired: PaymentRequired;
  payer: string;
  nonce: string;
  expirationTime: string;
};

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
  const { data: walletClient } = useWalletClient();
  const { connectAsync, connectors, isPending: connecting } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const [busy, setBusy] = useState(false);
  const [paid, setPaid] = useState(false);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  async function onPay() {
    if (!token || !address || !walletClient || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      if (chainId !== paymentChain.id) {
        await switchChainAsync({ chainId: paymentChain.id });
      }
      const res = await fetch(
        `${AGENTS}/pay/x402?token=${encodeURIComponent(token)}`,
      );
      if (res.status === 401 || res.status === 410) {
        setStatus(`Sign-in / pay link timed out, ${NEW_LINK}`);
        return;
      }
      if (res.status !== 402) {
        setStatus(`DeFiCat could not quote that, ${NEW_LINK}`);
        return;
      }
      const requirements = (await res.json()) as RequirementsResponse;
      if (getAddress(address) !== getAddress(requirements.payer)) {
        setStatus("Reconnect the wallet linked to Telegram.");
        return;
      }
      if (
        requirements.paymentRequired.accepts.every(
          (option) => option.network !== PAYMENT_NETWORK,
        )
      ) {
        setStatus("This payment is not available on Base Sepolia.");
        return;
      }

      const signer: ClientEvmSigner = {
        address: getAddress(address),
        signTypedData: async (typedData) =>
          walletClient.signTypedData({
            account: getAddress(address),
            ...typedData,
          } as Parameters<typeof walletClient.signTypedData>[0]),
      };
      const coreClient = new x402Client()
        .setSpendControls({ maxAmountPerPayment: "$0.10" })
        .register(PAYMENT_NETWORK, new ExactEvmScheme(signer));
      const x402 = new x402HTTPClient(coreClient);
      const payload = await x402.createPaymentPayload(
        requirements.paymentRequired,
      );

      const settle = await fetch(`${AGENTS}/pay/x402/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: requirements.nonce, payload }),
      });
      if (!settle.ok) {
        const detail = await settle
          .json()
          .then((body: unknown) =>
            typeof body === "object" &&
            body !== null &&
            "message" in body &&
            typeof body.message === "string"
              ? body.message
              : undefined,
          )
          .catch(() => undefined);
        setStatus(detail ?? `DeFiCat could not verify that, ${NEW_LINK}`);
        return;
      }
      const settled = (await settle.json()) as {
        txHash?: string;
        explorerUrl?: string;
      };
      const receipt =
        typeof settled.explorerUrl === "string"
          ? settled.explorerUrl
          : typeof settled.txHash === "string"
            ? `${paymentChain.blockExplorers.default.url}/tx/${settled.txHash}`
            : null;
      setPaid(true);
      setReceiptUrl(receipt);
      setStatus("Paid. Head back to Telegram — DeFiCat is running the job.");
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "The wallet could not create the payment.",
      );
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
            disabled={busy || paid}
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
        {receiptUrl ? (
          <a
            href={receiptUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-block text-sm font-semibold text-[#2AABEE] underline"
          >
            Open payment receipt
          </a>
        ) : null}
      </div>
    </div>
  );
}