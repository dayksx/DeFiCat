import { getAddress, isAddress, type Address, type Chain } from 'viem';
import { mainnet, sepolia } from 'viem/chains';

export type EthereumNetwork = {
  chainId: number;
  label: string;
  chain: Chain;
  ensRegistrarController: Address;
  ensPublicResolver: Address;
  ensSubgraphId: string;
};

export type EthereumNetworkOverrides = {
  ensRegistrarController?: string;
  ensPublicResolver?: string;
  ensSubgraphId?: string;
};

/**
 * Presets for SIWE + ENS.
 *
 * Sepolia is fine for SIWE, lookups and quotes, but **cannot register**: ENS
 * revoked the v1 registrar controllers there for the ENSv2 migration, so
 * `BaseRegistrar.controllers(NameWrapper)` is false and `register` reverts
 * after the commit has already cost gas.
 */
const PRESETS: Record<number, EthereumNetwork> = {
  [mainnet.id]: {
    chainId: mainnet.id,
    label: 'Ethereum mainnet',
    chain: mainnet,
    ensRegistrarController: getAddress(
      '0x253553366Da8546fC250F225fe3d25d0C782303b',
    ),
    ensPublicResolver: getAddress(
      '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63',
    ),
    ensSubgraphId: '5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH',
  },
  [sepolia.id]: {
    chainId: sepolia.id,
    label: 'Ethereum Sepolia',
    chain: sepolia,
    ensRegistrarController: getAddress(
      '0xFED6a969AaA60E4961FCD3EBF1A2e8913ac65B72',
    ),
    ensPublicResolver: getAddress(
      '0x8FADE66B79cC9f707aB26799354482EB93a5B7dD',
    ),
    ensSubgraphId: 'DmMXLtMZnGbQXASJ7p1jfzLUbBYnYUD9zNBTxpkjHYXV',
  },
};

export const DEFAULT_CHAIN_ID = mainnet.id;

export function ensSubgraphUrl(subgraphId: string): string {
  return `https://gateway.thegraph.com/api/subgraphs/id/${subgraphId}`;
}

export function parseChainId(raw: string | undefined): number {
  const value = Number(raw ?? String(DEFAULT_CHAIN_ID));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`CHAIN_ID must be a positive integer, got ${raw}`);
  }
  return value;
}

export function resolveEthereumNetwork(
  chainId: number,
  overrides: EthereumNetworkOverrides = {},
): EthereumNetwork {
  const preset = PRESETS[chainId];
  if (preset === undefined) {
    throw new Error(
      `Unsupported CHAIN_ID=${chainId}. Supported: ${Object.keys(PRESETS).join(', ')}`,
    );
  }
  return {
    ...preset,
    ensRegistrarController: optionalAddress(
      overrides.ensRegistrarController,
      preset.ensRegistrarController,
    ),
    ensPublicResolver: optionalAddress(
      overrides.ensPublicResolver,
      preset.ensPublicResolver,
    ),
    ensSubgraphId:
      overrides.ensSubgraphId?.trim() || preset.ensSubgraphId,
  };
}

function optionalAddress(raw: string | undefined, fallback: Address): Address {
  const value = raw?.trim();
  if (value === undefined || value === '') return fallback;
  if (!isAddress(value)) {
    throw new Error(`Expected a 0x address, got ${value}`);
  }
  return getAddress(value);
}
