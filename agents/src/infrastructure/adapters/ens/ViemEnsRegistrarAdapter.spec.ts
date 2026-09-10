import { describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import {
  ViemEnsRegistrarAdapter,
  type EnsChainDriver,
} from './ViemEnsRegistrarAdapter.js';

class FakeEnsChain implements EnsChainDriver {
  owner = '0x0000000000000000000000000000000000000001';
  isAvailable = true;
  price = { base: 100n, premium: 20n };
  commitHash = `0x${'1'.repeat(64)}`;
  registerHash = `0x${'2'.repeat(64)}`;
  calls: string[] = [];

  async available(): Promise<boolean> {
    this.calls.push('available');
    return this.isAvailable;
  }

  async rentPrice(): Promise<{ base: bigint; premium: bigint }> {
    this.calls.push('rentPrice');
    return this.price;
  }

  async balance(): Promise<bigint> {
    this.calls.push('balance');
    return 1_000n;
  }

  async makeCommitment(): Promise<Hex> {
    this.calls.push('makeCommitment');
    return `0x${'3'.repeat(64)}`;
  }

  async commit(): Promise<string> {
    this.calls.push('commit');
    return this.commitHash;
  }

  async minCommitmentAgeSeconds(): Promise<number> {
    this.calls.push('minCommitmentAge');
    return 60;
  }

  async register(): Promise<string> {
    this.calls.push('register');
    return this.registerHash;
  }
}

describe('ViemEnsRegistrarAdapter', () => {
  it('quotes with five percent slippage', async () => {
    const chain = new FakeEnsChain();
    const adapter = new ViemEnsRegistrarAdapter(chain);

    const quote = await adapter.quote({
      label: 'deficat',
      durationSeconds: 31_536_000,
    });

    expect(quote).toMatchObject({
      name: 'deficat.eth',
      available: true,
      totalWei: '120',
      valueWithSlippageWei: '126',
    });
  });

  it('executes commit, waits, requotes, then registers', async () => {
    const chain = new FakeEnsChain();
    const wait = vi.fn(async () => undefined);
    const adapter = new ViemEnsRegistrarAdapter(chain, wait);

    const receipt = await adapter.buy({
      label: 'deficat',
      durationSeconds: 31_536_000,
      maxTotalCostWei: '200',
    });

    expect(wait).toHaveBeenCalledWith(62_000);
    expect(chain.calls).toEqual([
      'available',
      'rentPrice',
      'balance',
      'makeCommitment',
      'commit',
      'minCommitmentAge',
      'available',
      'rentPrice',
      'balance',
      'register',
    ]);
    expect(receipt.registrationTransactionHash).toBe(chain.registerHash);
  });

  it('commits a name that is still registered, then registers once it drops', async () => {
    const chain = new FakeEnsChain();
    chain.isAvailable = false;
    const adapter = new ViemEnsRegistrarAdapter(chain, async () => undefined);

    const commitment = await adapter.commit({
      label: 'deficat',
      durationSeconds: 31_536_000,
    });

    expect(chain.calls).toEqual(['makeCommitment', 'commit']);
    expect(commitment.commitmentTransactionHash).toBe(chain.commitHash);

    chain.isAvailable = true;
    const receipt = await adapter.register({
      label: 'deficat',
      durationSeconds: 31_536_000,
      maxTotalCostWei: '200',
      secret: commitment.secret,
      commitmentTransactionHash: commitment.commitmentTransactionHash,
    });

    expect(receipt.registrationTransactionHash).toBe(chain.registerHash);
    expect(receipt.commitmentTransactionHash).toBe(chain.commitHash);
  });

  it('reuses a caller-supplied secret so a retried commit stays idempotent', async () => {
    const chain = new FakeEnsChain();
    const adapter = new ViemEnsRegistrarAdapter(chain, async () => undefined);
    const secret = `0x${'a'.repeat(64)}`;

    const first = await adapter.commit({
      label: 'deficat',
      durationSeconds: 31_536_000,
      secret,
    });
    const second = await adapter.commit({
      label: 'deficat',
      durationSeconds: 31_536_000,
      secret,
    });

    expect(first.secret).toBe(secret);
    expect(second.secret).toBe(secret);
  });

  it('rejects a malformed secret before touching the chain', async () => {
    const chain = new FakeEnsChain();
    const adapter = new ViemEnsRegistrarAdapter(chain, async () => undefined);

    await expect(
      adapter.commit({
        label: 'deficat',
        durationSeconds: 31_536_000,
        secret: '0xnope',
      }),
    ).rejects.toMatchObject({ failure: 'COMMIT_FAILED' });
    expect(chain.calls).toEqual([]);
  });

  it('blames the registration when the balance dropped since the commit', async () => {
    const chain = new FakeEnsChain();
    chain.balance = async () => 1n;
    const adapter = new ViemEnsRegistrarAdapter(chain, async () => undefined);

    await expect(
      adapter.register({
        label: 'deficat',
        durationSeconds: 31_536_000,
        maxTotalCostWei: '200',
        secret: `0x${'a'.repeat(64)}`,
        commitmentTransactionHash: chain.commitHash,
      }),
    ).rejects.toMatchObject({
      failure: 'REGISTRATION_FAILED',
      commitmentTransactionHash: chain.commitHash,
    });
    expect(chain.calls).not.toContain('register');
  });

  it('does not commit when the quote exceeds the budget', async () => {
    const chain = new FakeEnsChain();
    const adapter = new ViemEnsRegistrarAdapter(chain, async () => undefined);

    await expect(
      adapter.buy({
        label: 'deficat',
        durationSeconds: 31_536_000,
        maxTotalCostWei: '125',
      }),
    ).rejects.toThrow('exceeds the agent budget');
    expect(chain.calls).not.toContain('commit');
  });

  it('reports OVER_BUDGET without committing', async () => {
    const chain = new FakeEnsChain();
    const adapter = new ViemEnsRegistrarAdapter(chain, async () => undefined);

    await expect(
      adapter.buy({
        label: 'deficat',
        durationSeconds: 31_536_000,
        maxTotalCostWei: '125',
      }),
    ).rejects.toMatchObject({ failure: 'OVER_BUDGET' });
  });

  it('reports INSUFFICIENT_FUNDS without committing', async () => {
    const chain = new FakeEnsChain();
    chain.balance = async () => 1n;
    const adapter = new ViemEnsRegistrarAdapter(chain, async () => undefined);

    await expect(
      adapter.buy({
        label: 'deficat',
        durationSeconds: 31_536_000,
        maxTotalCostWei: '200',
      }),
    ).rejects.toMatchObject({ failure: 'INSUFFICIENT_FUNDS' });
    expect(chain.calls).not.toContain('commit');
  });

  it('keeps the commitment hash when registration fails after the commit', async () => {
    const chain = new FakeEnsChain();
    chain.register = async () => {
      throw new Error('replacement transaction underpriced');
    };
    const adapter = new ViemEnsRegistrarAdapter(chain, async () => undefined);

    await expect(
      adapter.buy({
        label: 'deficat',
        durationSeconds: 31_536_000,
        maxTotalCostWei: '200',
      }),
    ).rejects.toMatchObject({
      failure: 'REGISTRATION_FAILED',
      commitmentTransactionHash: chain.commitHash,
    });
  });

  it('reports the name being sniped during the commitment wait', async () => {
    const chain = new FakeEnsChain();
    const adapter = new ViemEnsRegistrarAdapter(chain, async () => {
      chain.isAvailable = false;
    });

    await expect(
      adapter.buy({
        label: 'deficat',
        durationSeconds: 31_536_000,
        maxTotalCostWei: '200',
      }),
    ).rejects.toMatchObject({
      failure: 'REGISTRATION_FAILED',
      commitmentTransactionHash: chain.commitHash,
    });
    expect(chain.calls).not.toContain('register');
  });
});
