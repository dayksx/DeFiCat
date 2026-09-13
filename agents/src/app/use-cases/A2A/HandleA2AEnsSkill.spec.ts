import { describe, expect, it, vi } from 'vitest';
import type { PaymentPayload } from '@x402/core/types';
import { DomainError } from '../../../domain/errors/DomainError.js';
import { EnsPurchasePolicy } from '../../../domain/ens/EnsPurchasePolicy.js';
import { PurchaseEnsName } from '../PurchaseEnsName/PurchaseEnsName.js';
import type {
  EnsRegistrarPort,
  EnsRegistrationQuote,
  EnsRegistrationReceipt,
} from '../../ports/ens/EnsRegistrarPort.js';
import type { IssueA2APaymentSession } from '../Billing/IssueA2APaymentSession.js';
import type { GetX402Requirements } from '../Billing/GetX402Requirements.js';
import type { SettlePaymentAndFulfill } from '../Billing/SettlePaymentAndFulfill.js';
import type { PaymentRequired } from '@x402/core/types';
import { HandleA2AEnsSkill } from './HandleA2AEnsSkill.js';
import { offerFor } from '../../../domain/billing/ServiceCatalog.js';

const YEAR_SECONDS = 365 * 24 * 60 * 60;
const PAYLOAD = {
  x402Version: 2,
  accepted: {
    scheme: 'exact',
    network: 'eip155:84532',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amount: '10000',
    payTo: '0x224b11F0747c7688a10aCC15F785354aA6493ED6',
    maxTimeoutSeconds: 60,
    extra: { session: 'a2a-nonce-1' },
  },
  payload: {},
} as unknown as PaymentPayload;

function quoteOf(
  overrides: Partial<EnsRegistrationQuote> = {},
): EnsRegistrationQuote {
  return {
    name: 'kikoulol.eth',
    owner: '0x0000000000000000000000000000000000000001',
    available: true,
    durationSeconds: YEAR_SECONDS,
    baseWei: '100',
    premiumWei: '0',
    totalWei: '100',
    valueWithSlippageWei: '105',
    ...overrides,
  };
}

function registrarOf(quote: EnsRegistrationQuote): EnsRegistrarPort {
  return {
    quote: vi.fn(async () => quote),
    buy: vi.fn(async (): Promise<EnsRegistrationReceipt> => {
      throw new Error('HandleA2AEnsSkill must not buy before payment');
    }),
    commit: vi.fn(async () => {
      throw new Error('not used');
    }),
    register: vi.fn(async (): Promise<EnsRegistrationReceipt> => {
      throw new Error('not used');
    }),
    minCommitmentAgeSeconds: vi.fn(async () => 60),
  };
}

function paymentRequired(): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: 'http://localhost:3000/a2a/ens/buy' },
    accepts: [],
  };
}

function useCaseOf(quote: EnsRegistrationQuote) {
  const purchase = new PurchaseEnsName(
    registrarOf(quote),
    new EnsPurchasePolicy(),
    '1000',
  );
  const issue = {
    execute: vi.fn(async (input: { intent: { type: string } }) => ({
      offer: offerFor(
        input.intent.type === 'ens.schedule' ? 'ens.watch.arm' : 'ens.buy.now',
      ),
      nonce: 'a2a-nonce-1',
      expiresAt: new Date('2026-09-13T18:00:00.000Z'),
      payUrl: 'http://localhost:3000/a2a/ens/buy',
    })),
  } as unknown as IssueA2APaymentSession;
  const requirements = {
    execute: vi.fn(async () => ({
      paymentRequired: paymentRequired(),
      payer: '0x0',
      nonce: 'a2a-nonce-1',
      issuedAt: '2026-09-13T17:45:00.000Z',
      expirationTime: '2026-09-13T18:00:00.000Z',
    })),
  } as unknown as GetX402Requirements;
  const settle = {
    execute: vi.fn(async () => ({
      paid: true,
      fulfilling: true,
      txHash: `0x${'a'.repeat(64)}`,
      fulfillment: {
        type: 'ens.buy',
        name: 'kikoulol.eth',
        owner: '0x1',
        transactionHash: `0x${'b'.repeat(64)}`,
        totalPaidWei: '105',
        message: 'Registered kikoulol.eth.',
      },
    })),
  } as unknown as SettlePaymentAndFulfill;

  return {
    issue,
    settle,
    useCase: new HandleA2AEnsSkill(purchase, issue, requirements, settle),
  };
}

describe('HandleA2AEnsSkill', () => {
  it('challenges 0.01 USDC before buying an available name', async () => {
    const { useCase, issue, settle } = useCaseOf(quoteOf());

    const result = await useCase.execute({
      skill: 'buy',
      name: 'kikoulol.eth',
      years: 1,
      resourceUrl: 'http://localhost:3000/a2a/ens/buy',
    });

    expect(result.status).toBe('payment_required');
    if (result.status === 'payment_required') {
      expect(result.offer.sku).toBe('ens.buy.now');
      expect(result.offer.amountAtomic).toBe(10_000n);
    }
    expect(issue.execute).toHaveBeenCalledTimes(1);
    expect(settle.execute).not.toHaveBeenCalled();
  });

  it('settles then fulfills when the caller attached a payment payload', async () => {
    const { useCase, settle } = useCaseOf(quoteOf());

    const result = await useCase.execute({
      skill: 'buy',
      name: 'kikoulol.eth',
      years: 1,
      resourceUrl: 'http://localhost:3000/a2a/ens/buy',
      payload: PAYLOAD,
    });

    expect(result.status).toBe('paid');
    expect(settle.execute).toHaveBeenCalledWith({
      token: 'a2a-nonce-1',
      payload: PAYLOAD,
      awaitFulfillment: true,
    });
  });

  it('refuses to invoice a buy when the name should be scheduled instead', async () => {
    const { useCase, issue } = useCaseOf(quoteOf({ available: false }));

    await expect(
      useCase.execute({
        skill: 'buy',
        name: 'kikoulol.eth',
        years: 1,
        resourceUrl: 'http://localhost:3000/a2a/ens/buy',
      }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(issue.execute).not.toHaveBeenCalled();
  });

  it('challenges 0.1 USDC to schedule a taken name', async () => {
    const { useCase, issue } = useCaseOf(quoteOf({ available: false }));

    const result = await useCase.execute({
      skill: 'schedule',
      name: 'kikoulol.eth',
      years: 1,
      resourceUrl: 'http://localhost:3000/a2a/ens/schedule',
    });

    expect(result.status).toBe('payment_required');
    if (result.status === 'payment_required') {
      expect(result.offer.sku).toBe('ens.watch.arm');
      expect(result.offer.amountAtomic).toBe(100_000n);
    }
    expect(issue.execute).toHaveBeenCalledWith({
      intent: { type: 'ens.schedule', label: 'kikoulol', years: 1 },
      resourceUrl: 'http://localhost:3000/a2a/ens/schedule',
    });
  });
});
