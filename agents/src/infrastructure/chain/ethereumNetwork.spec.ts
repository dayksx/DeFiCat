import { describe, expect, it } from 'vitest';
import { mainnet } from 'viem/chains';
import {
  DEFAULT_CHAIN_ID,
  parseChainId,
  resolveEthereumNetwork,
} from './ethereumNetwork.js';

describe('ethereumNetwork', () => {
  it('defaults to mainnet', () => {
    expect(parseChainId(undefined)).toBe(mainnet.id);
    expect(DEFAULT_CHAIN_ID).toBe(mainnet.id);
  });

  it('resolves mainnet and Sepolia presets', () => {
    expect(resolveEthereumNetwork(1).label).toBe('Ethereum mainnet');
    expect(resolveEthereumNetwork(11_155_111).label).toBe('Ethereum Sepolia');
  });

  it('rejects an unknown chain', () => {
    expect(() => resolveEthereumNetwork(10)).toThrow(/Unsupported CHAIN_ID=10/);
  });

  it('applies contract overrides', () => {
    const network = resolveEthereumNetwork(11_155_111, {
      ensRegistrarController: '0x0000000000000000000000000000000000000001',
      ensSubgraphId: 'customSubgraph',
    });
    expect(network.ensRegistrarController).toBe(
      '0x0000000000000000000000000000000000000001',
    );
    expect(network.ensSubgraphId).toBe('customSubgraph');
  });
});
