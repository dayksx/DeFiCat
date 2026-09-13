import type { ServiceSku } from "./ServiceCatalog.js";

export type PaidIntent =
  | { type: "ens.buy"; label: string; years: number }
  | { type: "ens.subname"; name: string }
  | { type: "ens.schedule"; label: string; years: number };

export function skuFor(intent: PaidIntent): ServiceSku {
  if (intent.type === "ens.buy") return "ens.buy.now";
  if (intent.type === "ens.subname") return "ens.subname.create";
  return "ens.watch.arm";
}

/** One receipt cannot pay a different name / duration. */
export function intentKey(intent: PaidIntent): string {
  if (intent.type === "ens.subname") {
    return `${intent.type}:${intent.name}`;
  }
  return `${intent.type}:${intent.label}:${intent.years}`;
}
