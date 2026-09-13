export type PaymentIssuance = {
    payTo: string;
    chainId: number;
    asset: string;
    network: string;
    uiOrigin: string;
    extraName: string;
    extraVersion: string;
  };