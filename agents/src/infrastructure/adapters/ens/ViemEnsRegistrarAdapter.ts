import { randomBytes } from 'node:crypto';
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import {
  EnsRegistrationError,
  type EnsRegistrarPort,
  type EnsRegistrationFailure,
  type EnsRegistrationInput,
  type EnsRegistrationQuote,
  type EnsRegistrationReceipt,
} from '../../../app/ports/ens/EnsRegistrarPort.js';

export const ENS_REGISTRAR_CONTROLLER =
  '0x253553366Da8546fC250F225fe3d25d0C782303b';
export const ENS_PUBLIC_RESOLVER = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63';

const ensRegistrarControllerAbi = [
  {
    type: 'function',
    name: 'available',
    stateMutability: 'view',
    inputs: [{ name: 'name', type: 'string' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'rentPrice',
    stateMutability: 'view',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'duration', type: 'uint256' },
    ],
    outputs: [
      {
        name: 'price',
        type: 'tuple',
        components: [
          { name: 'base', type: 'uint256' },
          { name: 'premium', type: 'uint256' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'makeCommitment',
    stateMutability: 'pure',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'owner', type: 'address' },
      { name: 'duration', type: 'uint256' },
      { name: 'secret', type: 'bytes32' },
      { name: 'resolver', type: 'address' },
      { name: 'data', type: 'bytes[]' },
      { name: 'reverseRecord', type: 'bool' },
      { name: 'ownerControlledFuses', type: 'uint16' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'commit',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'commitment', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'register',
    stateMutability: 'payable',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'owner', type: 'address' },
      { name: 'duration', type: 'uint256' },
      { name: 'secret', type: 'bytes32' },
      { name: 'resolver', type: 'address' },
      { name: 'data', type: 'bytes[]' },
      { name: 'reverseRecord', type: 'bool' },
      { name: 'ownerControlledFuses', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'MIN_COMMITMENT_AGE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export type EnsChainDriver = {
  owner: string;
  available(label: string): Promise<boolean>;
  rentPrice(
    label: string,
    durationSeconds: number,
  ): Promise<{ base: bigint; premium: bigint }>;
  balance(): Promise<bigint>;
  makeCommitment(input: {
    label: string;
    durationSeconds: number;
    secret: Hex;
  }): Promise<Hex>;
  commit(commitment: Hex): Promise<string>;
  minCommitmentAgeSeconds(): Promise<number>;
  register(input: {
    label: string;
    durationSeconds: number;
    secret: Hex;
    value: bigint;
  }): Promise<string>;
};

export class ViemEnsRegistrarAdapter implements EnsRegistrarPort {
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly chain: EnsChainDriver,
    private readonly wait: (milliseconds: number) => Promise<void> = sleep,
  ) {}

  static create(opts: {
    privateKey: Hex;
    rpcUrl: string;
  }): ViemEnsRegistrarAdapter {
    const account = privateKeyToAccount(opts.privateKey);
    const publicClient = createPublicClient({
      chain: mainnet,
      transport: http(opts.rpcUrl),
    });
    const walletClient = createWalletClient({
      account,
      chain: mainnet,
      transport: http(opts.rpcUrl),
    });

    const contract = {
      address: ENS_REGISTRAR_CONTROLLER as Address,
      abi: ensRegistrarControllerAbi,
    } as const;

    const driver: EnsChainDriver = {
      owner: account.address,
      available: (label) =>
        publicClient.readContract({
          ...contract,
          functionName: 'available',
          args: [label],
        }),
      rentPrice: async (label, durationSeconds) => {
        const price = await publicClient.readContract({
          ...contract,
          functionName: 'rentPrice',
          args: [label, BigInt(durationSeconds)],
        });
        return { base: price.base, premium: price.premium };
      },
      balance: () => publicClient.getBalance({ address: account.address }),
      makeCommitment: (input) =>
        publicClient.readContract({
          ...contract,
          functionName: 'makeCommitment',
          args: [
            input.label,
            account.address,
            BigInt(input.durationSeconds),
            input.secret,
            ENS_PUBLIC_RESOLVER,
            [],
            false,
            0,
          ],
        }),
      commit: async (commitment) => {
        const { request } = await publicClient.simulateContract({
          ...contract,
          account,
          functionName: 'commit',
          args: [commitment],
        });
        const hash = await walletClient.writeContract(request);
        await publicClient.waitForTransactionReceipt({ hash });
        return hash;
      },
      minCommitmentAgeSeconds: async () =>
        Number(
          await publicClient.readContract({
            ...contract,
            functionName: 'MIN_COMMITMENT_AGE',
          }),
        ),
      register: async (input) => {
        const { request } = await publicClient.simulateContract({
          ...contract,
          account,
          functionName: 'register',
          args: [
            input.label,
            account.address,
            BigInt(input.durationSeconds),
            input.secret,
            ENS_PUBLIC_RESOLVER,
            [],
            false,
            0,
          ],
          value: input.value,
        });
        const hash = await walletClient.writeContract(request);
        await publicClient.waitForTransactionReceipt({ hash });
        return hash;
      },
    };

    return new ViemEnsRegistrarAdapter(driver);
  }

  async quote(
    input: Omit<EnsRegistrationInput, 'maxTotalCostWei'>,
  ): Promise<EnsRegistrationQuote> {
    try {
      const [available, price] = await Promise.all([
        this.chain.available(input.label),
        this.chain.rentPrice(input.label, input.durationSeconds),
      ]);
      const total = price.base + price.premium;
      return {
        name: `${input.label}.eth`,
        owner: this.chain.owner,
        available,
        durationSeconds: input.durationSeconds,
        baseWei: price.base.toString(),
        premiumWei: price.premium.toString(),
        totalWei: total.toString(),
        valueWithSlippageWei: withSlippage(total).toString(),
      };
    } catch (error) {
      throw wrapError(
        'CHAIN_UNAVAILABLE',
        'Could not quote the ENS registration',
        error,
      );
    }
  }

  async buy(input: EnsRegistrationInput): Promise<EnsRegistrationReceipt> {
    const run = this.operation.then(() => this.buyExclusive(input));
    this.operation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async buyExclusive(
    input: EnsRegistrationInput,
  ): Promise<EnsRegistrationReceipt> {
    const initial = await this.quote(input);
    assertPurchasable(initial, input.maxTotalCostWei);
    await this.assertFunded(initial.valueWithSlippageWei);

    const secret = bytesToHex(randomBytes(32));
    let commitmentTransactionHash: string;
    try {
      const commitment = await this.chain.makeCommitment({
        label: input.label,
        durationSeconds: input.durationSeconds,
        secret,
      });
      commitmentTransactionHash = await this.chain.commit(commitment);
    } catch (error) {
      throw wrapError(
        'COMMIT_FAILED',
        'Could not submit the ENS commitment',
        error,
      );
    }

    // Past this point the commitment is mined, so every failure has already cost gas.
    try {
      const minAge = await this.chain.minCommitmentAgeSeconds();
      await this.wait((minAge + 2) * 1_000);

      const final = await this.quote(input);
      assertPurchasable(final, input.maxTotalCostWei);
      const value = BigInt(final.valueWithSlippageWei);
      const registrationTransactionHash = await this.chain.register({
        label: input.label,
        durationSeconds: input.durationSeconds,
        secret,
        value,
      });

      return {
        name: final.name,
        owner: this.chain.owner,
        commitmentTransactionHash,
        registrationTransactionHash,
        totalPaidWei: value.toString(),
      };
    } catch (error) {
      const reason =
        error instanceof EnsRegistrationError
          ? error.message
          : 'the registration transaction did not complete';
      throw new EnsRegistrationError(
        'REGISTRATION_FAILED',
        `Commitment was mined but ${reason}`,
        { cause: error, commitmentTransactionHash },
      );
    }
  }

  private async assertFunded(valueWei: string): Promise<void> {
    let balance: bigint;
    try {
      balance = await this.chain.balance();
    } catch (error) {
      throw wrapError(
        'CHAIN_UNAVAILABLE',
        'Could not read the agent balance',
        error,
      );
    }
    if (balance < BigInt(valueWei)) {
      throw new EnsRegistrationError(
        'INSUFFICIENT_FUNDS',
        'Agent EOA has insufficient ETH for this registration',
      );
    }
  }
}

function withSlippage(value: bigint): bigint {
  return (value * 105n + 99n) / 100n;
}

function assertPurchasable(
  quote: EnsRegistrationQuote,
  maxTotalCostWei: string,
): void {
  if (!quote.available) {
    throw new EnsRegistrationError(
      'UNAVAILABLE',
      `${quote.name} is not available`,
    );
  }
  if (BigInt(quote.valueWithSlippageWei) > BigInt(maxTotalCostWei)) {
    throw new EnsRegistrationError(
      'OVER_BUDGET',
      'ENS registration price exceeds the agent budget',
    );
  }
}

function wrapError(
  failure: EnsRegistrationFailure,
  message: string,
  cause: unknown,
): EnsRegistrationError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new EnsRegistrationError(failure, `${message}: ${detail}`, { cause });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
