import { http, createConfig } from "wagmi";
import { mainnet, sepolia, type Chain } from "wagmi/chains";
import { injected } from "wagmi/connectors";

const SUPPORTED = {
  [mainnet.id]: mainnet,
  [sepolia.id]: sepolia,
} as const;

function uiChain(): Chain {
  const id = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "1");
  const chain = SUPPORTED[id as keyof typeof SUPPORTED];
  if (chain === undefined) {
    throw new Error(
      `Unsupported NEXT_PUBLIC_CHAIN_ID=${id}. Use 1 (mainnet) or 11155111 (sepolia).`,
    );
  }
  return chain;
}

const chain = uiChain();

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected()],
  // Sans ça, le serveur rend « Connect wallet » et le client, déjà reconnecté
  // depuis le storage, rend l'adresse : hydration mismatch.
  ssr: true,
  transports: {
    [chain.id]: http(),
  },
});
