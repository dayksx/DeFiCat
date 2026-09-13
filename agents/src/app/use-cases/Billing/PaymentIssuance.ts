export type PaymentIssuance = {
  payTo: string;
  chainId: number;
  asset: string;
  network: `${string}:${string}`;
  uiOrigin: string;
  extraName: string;
  extraVersion: string;
};
