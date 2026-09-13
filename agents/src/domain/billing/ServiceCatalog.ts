export type OfferKind = 'immediate' | 'scheduled';

export type ServiceSku = 'ens.buy.now' | 'ens.subname.create' | 'ens.watch.arm';

export type ServiceOffer = {
  sku: ServiceSku;
  kind: OfferKind;
  amountAtomic: bigint; // 10_000n = 0.01 USDC (6 decimals)
  label: string;
};

const OFFERS: Record<ServiceSku, ServiceOffer> = {
  'ens.buy.now': {
    sku: 'ens.buy.now',
    kind: 'immediate',
    amountAtomic: 10_000n,
    label: 'Buy an available .eth now',
  },
  'ens.subname.create': {
    sku: 'ens.subname.create',
    kind: 'immediate',
    amountAtomic: 10_000n,
    label: 'Create a subname under an agent-owned .eth',
  },
  'ens.watch.arm': {
    sku: 'ens.watch.arm',
    kind: 'scheduled',
    amountAtomic: 100_000n,
    label: 'Watch a .eth and buy when it drops',
  },
};

export function offerFor(sku: ServiceSku): ServiceOffer {
  return OFFERS[sku];
}
