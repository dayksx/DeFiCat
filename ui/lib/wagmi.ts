import { http, createConfig } from "wagmi";
import { baseSepolia, mainnet, sepolia, type Chain } from "wagmi/chains";
import { injected } from "wagmi/connectors";

const ENS_CHAIN = {
  [mainnet.id]: mainnet,
  [sepolia.id]: sepolia,
} as const;

function ensChain(): Chain {
  const id = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "1");
  const chain = ENS_CHAIN[id as keyof typeof ENS_CHAIN];
  if (chain === undefined) {
    throw new Error(`Unsupported NEXT_PUBLIC_CHAIN_ID=${id}`);
  }
  return chain;
}

const ens = ensChain();

export const wagmiConfig = createConfig({
  chains: [ens, baseSepolia],
  connectors: [injected()],
  ssr: true,
  transports: {
    [ens.id]: http(),
    [baseSepolia.id]: http(),
  },
});