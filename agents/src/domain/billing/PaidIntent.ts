import type { ServiceSku } from "./ServiceCatalog.js";

export type PaidIntent =
  | { type: "ens.buy"; label: string; years: number }
  | { type: "ens.schedule"; label: string; years: number };

export function skuFor(intent: PaidIntent): ServiceSku {
  return intent.type === "ens.buy" ? "ens.buy.now" : "ens.watch.arm";
}

/** One receipt cannot pay a different name / duration. */
export function intentKey(intent: PaidIntent): string {
  return `${intent.type}:${intent.label}:${intent.years}`;
}
