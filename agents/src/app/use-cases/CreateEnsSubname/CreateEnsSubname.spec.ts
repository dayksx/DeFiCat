import { describe, expect, it } from 'vitest';
import type {
  EnsSubnameInput,
  EnsSubnamePort,
  EnsSubnameQuote,
} from '../../ports/ens/EnsSubnamePort.js';
import { EnsSubnamePolicy } from '../../../domain/ens/EnsSubnamePolicy.js';
import { CreateEnsSubname } from './CreateEnsSubname.js';

class FakeSubnames implements EnsSubnamePort {
  quote: EnsSubnameQuote = {
    name: 'me.kikoulol.eth',
    parentName: 'kikoulol.eth',
    owner: '0x0000000000000000000000000000000000000001',
    available: true,
    parentOwnedByAgent: true,
    parentExpiry: new Date('2028-01-01T00:00:00.000Z'),
  };
  creates = 0;

  async inspect(): Promise<EnsSubnameQuote> {
    return this.quote;
  }

  async createSubname(input: EnsSubnameInput) {
    this.creates += 1;
    return {
      name: input.name,
      parentName: input.parentName,
      owner: this.quote.owner,
      expiry: this.quote.parentExpiry,
      transactionHash: `0x${'1'.repeat(64)}`,
    };
  }
}

describe('CreateEnsSubname', () => {
  it('checks ownership and availability before creating', async () => {
    const port = new FakeSubnames();
    const useCase = new CreateEnsSubname(port, new EnsSubnamePolicy());

    const receipt = await useCase.execute({ name: 'me.kikoulol.eth' });

    expect(receipt.name).toBe('me.kikoulol.eth');
    expect(port.creates).toBe(1);
  });

  it('refuses a parent not owned by the agent', async () => {
    const port = new FakeSubnames();
    port.quote = { ...port.quote, parentOwnedByAgent: false };
    const useCase = new CreateEnsSubname(port, new EnsSubnamePolicy());

    await expect(
      useCase.execute({ name: 'me.kikoulol.eth' }),
    ).rejects.toMatchObject({ code: 'PARENT_NOT_OWNED' });
    expect(port.creates).toBe(0);
  });

  it('refuses an existing subname', async () => {
    const port = new FakeSubnames();
    port.quote = { ...port.quote, available: false };
    const useCase = new CreateEnsSubname(port, new EnsSubnamePolicy());

    await expect(
      useCase.execute({ name: 'me.kikoulol.eth' }),
    ).rejects.toMatchObject({ code: 'SUBNAME_UNAVAILABLE' });
    expect(port.creates).toBe(0);
  });
});
