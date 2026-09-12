import { http, createConfig } from "wagmi";
import { mainnet, sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const wagmiConfig = createConfig({
  chains: [mainnet, sepolia],
  connectors: [injected()],
  // Sans ça, le serveur rend « Connect wallet » et le client, déjà reconnecté
  // depuis le storage, rend l'adresse : hydration mismatch.
  ssr: true,
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
});
