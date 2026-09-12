"use client";

import { getAddress } from "viem";
import { createSiweMessage } from "viem/siwe";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAccount, useConnect, useSignMessage } from "wagmi";

const AGENTS = process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3000";

const NEW_LINK = "please chat to DeFiCat to get a new sign-in link";

type Challenge = {
  nonce: string;
  domain: string;
  uri: string;
  chainId: number;
  statement: string;
  version: "1";
  issuedAt: string;
  expirationTime: string;
};

type Status = { tone: "info" | "success"; text: string };

/** Traduit une panne technique en une phrase actionnable. */
function fail(err: unknown): string {
  const raw = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/user rejected|user denied|4001/i.test(raw)) {
    return "You cancelled the signature. Tap sign again whenever you're ready 😽";
  }
  if (/fetch|network|load failed/i.test(raw)) {
    return "DeFiCat is not answering right now. Give it a few seconds and retry 🛠️";
  }
  return `Something went sideways, ${NEW_LINK} 😿`;
}

/** Le détail technique reste pour la console ; l'utilisateur lit une phrase. */
function httpFail(status: number): string {
  if (status === 401) {
    return `Sign-in timed out, ${NEW_LINK} 😿`;
  }
  if (status === 400) {
    return `This link looks broken, ${NEW_LINK} 😿`;
  }
  return `DeFiCat could not verify that, ${NEW_LINK} 😿`;
}

async function logReason(res: Response): Promise<void> {
  try {
    const body = (await res.json()) as { message?: string };
    console.debug("[siwe]", res.status, body.message ?? res.statusText);
  } catch {
    console.debug("[siwe]", res.status, res.statusText);
  }
}

function parseChallenge(raw: unknown): Challenge {
  if (raw === null || typeof raw !== "object") {
    throw new Error("Invalid challenge payload");
  }
  const c = raw as Record<string, unknown>;
  if (
    typeof c.nonce !== "string" ||
    typeof c.domain !== "string" ||
    typeof c.uri !== "string" ||
    typeof c.chainId !== "number" ||
    typeof c.statement !== "string" ||
    c.version !== "1" ||
    typeof c.issuedAt !== "string" ||
    typeof c.expirationTime !== "string"
  ) {
    throw new Error("Invalid challenge payload");
  }
  return {
    nonce: c.nonce,
    domain: c.domain,
    uri: c.uri,
    chainId: c.chainId,
    statement: c.statement,
    version: "1",
    issuedAt: c.issuedAt,
    expirationTime: c.expirationTime,
  };
}

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Bulle façon Telegram : moins agressif qu'un bandeau d'erreur rouge. */
function CatBubble({ status }: { status: Status }) {
  return (
    <div className="mt-7 flex items-end gap-2 text-left">
      <div
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#2AABEE] to-[#229ED9] text-base"
      >
        😽
      </div>
      <div
        className={`rounded-2xl rounded-bl-md px-4 py-2.5 text-sm leading-6 backdrop-blur-sm ${
          status.tone === "success"
            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : "bg-zinc-900/[0.06] text-zinc-700 dark:bg-white/10 dark:text-zinc-200"
        }`}
      >
        {status.text}
      </div>
    </div>
  );
}

function SiweForm() {
  const token = useSearchParams().get("token") ?? "";
  const { address, isConnected } = useAccount();
  const { connectAsync, connectors, isPending: connecting } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState(false);
  // L'état du wallet n'existe pas côté serveur. Tant que `mounted` est faux,
  // le client rend exactement le HTML du serveur : plus de mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const walletReady = mounted && isConnected;

  function say(text: string, tone: Status["tone"] = "info") {
    setStatus({ tone, text });
  }

  async function onConnect() {
    const connector = connectors[0];
    if (connector === undefined) {
      say("No browser wallet here. Install MetaMask and reload 🦊");
      return;
    }
    try {
      await connectAsync({ connector });
      setStatus(null);
    } catch (err) {
      say(fail(err));
    }
  }

  async function onSign() {
    if (busy || !token || !address) return;
    setBusy(true);
    try {
      await bind(address);
    } catch (err) {
      say(fail(err));
    } finally {
      setBusy(false);
    }
  }

  async function bind(rawAddress: string) {
    const checksum = getAddress(rawAddress);
    say("Fetching your sign-in challenge…");
    const res = await fetch(
      `${AGENTS}/auth/siwe/challenge?token=${encodeURIComponent(token)}`,
    );
    if (!res.ok) {
      await logReason(res);
      say(httpFail(res.status));
      return;
    }
    const challenge = parseChallenge(await res.json());
    const issuedAt = new Date(challenge.issuedAt);
    const expirationTime = new Date(challenge.expirationTime);
    if (
      Number.isNaN(issuedAt.getTime()) ||
      Number.isNaN(expirationTime.getTime())
    ) {
      throw new Error("Invalid challenge timestamps");
    }
    const message = createSiweMessage({
      address: checksum,
      chainId: challenge.chainId,
      domain: challenge.domain,
      nonce: challenge.nonce,
      uri: challenge.uri,
      version: "1",
      statement: challenge.statement,
      issuedAt,
      expirationTime,
    });
    say("Check your wallet and sign 🖊️");
    const signature = await signMessageAsync({ message });
    say("Verifying onchain identity…");
    const verify = await fetch(`${AGENTS}/auth/siwe/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: challenge.nonce,
        address: checksum,
        message,
        signature,
      }),
    });
    if (!verify.ok) {
      await logReason(verify);
      say(httpFail(verify.status));
      return;
    }
    setLinked(true);
    say("Wallet linked. Head back to Telegram and ape in 🚀", "success");
  }

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm text-center">
        <div className="relative mx-auto size-24">
          <div
            aria-hidden
            className="absolute inset-0 animate-pulse rounded-full bg-[#2AABEE]/30 blur-2xl"
          />
          <div
            aria-hidden
            className="relative flex size-24 items-center justify-center rounded-full bg-gradient-to-br from-[#2AABEE] to-[#229ED9] text-5xl shadow-xl shadow-[#2AABEE]/40"
          >
            😽
          </div>
        </div>

        <h1 className="mt-6 bg-gradient-to-r from-[#2AABEE] to-[#229ED9] bg-clip-text text-3xl font-black tracking-tight text-transparent">
          DeFiCat
        </h1>
        <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
          Sign once, then let the cat farm onchain alpha for you.
        </p>

        <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-zinc-900/[0.06] px-3 py-1 text-[11px] font-medium tracking-wide text-zinc-600 uppercase dark:bg-white/10 dark:text-zinc-300">
          no gas · no funds moved
        </p>

        {!token ? (
          <CatBubble
            status={{
              tone: "info",
              text: `This link has no token, ${NEW_LINK} 😿`,
            }}
          />
        ) : (
          <>
            <div className="mt-8 flex flex-col gap-3">
              {!walletReady ? (
                <button
                  type="button"
                  // Avant le montage, l'attribut est absent des deux côtés :
                  // aucun état client ne peut diverger du HTML serveur.
                  disabled={mounted ? connecting || busy : undefined}
                  onClick={() => void onConnect()}
                  className="h-12 rounded-full bg-gradient-to-r from-[#2AABEE] to-[#229ED9] text-sm font-bold text-white shadow-lg shadow-[#2AABEE]/30 transition hover:brightness-110 active:scale-[0.98] disabled:opacity-50 disabled:hover:brightness-100"
                >
                  {connecting ? "Connecting…" : "Connect wallet 🔌"}
                </button>
              ) : (
                <p className="font-mono text-xs tracking-wider text-zinc-500 dark:text-zinc-400">
                  {shorten(address ?? "")}
                </p>
              )}

              <button
                type="button"
                disabled={mounted ? !walletReady || busy || linked : undefined}
                onClick={() => void onSign()}
                className="h-12 rounded-full bg-gradient-to-r from-[#2AABEE] to-[#229ED9] text-sm font-bold text-white shadow-lg shadow-[#2AABEE]/30 transition hover:brightness-110 active:scale-[0.98] disabled:opacity-40 disabled:shadow-none disabled:hover:brightness-100"
              >
                {busy
                  ? "Signing…"
                  : linked
                    ? "Signed 😽"
                    : "Sign in with Ethereum 🚀"}
              </button>
            </div>

            <div aria-live="polite">
              {status === null ? null : <CatBubble status={status} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function SiwePage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
          Loading…
        </div>
      }
    >
      <SiweForm />
    </Suspense>
  );
}
