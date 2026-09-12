import { Logger } from "@nestjs/common";
import { tool } from "langchain";
import { z } from "zod";
import type {
  EnsDomainRecord,
  EnsLookupPort,
  EnsLookupResult,
} from "../../../../app/ports/graph/EnsLookupPort.js";
import type { IsoZoneFormatter } from "../../../time/createIsoZoneFormatter.js";

const inputSchema = z.object({
  name: z
    .string()
    .optional()
    .describe("ENS name to look up, e.g. vitalik.eth"),
  address: z
    .string()
    .optional()
    .describe(
      "Ethereum address (0x…) to find owned or reverse-resolved ENS names",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Max domains to return for an address lookup (default 10)"),
});

export function createEnsLookupTool(
  ens: EnsLookupPort,
  toLocalIso: IsoZoneFormatter,
  networkLabel = "Ethereum",
) {
  const logger = new Logger("EnsLookupTool");

  return tool(
    async (input) => {
      const name = input.name?.trim();
      const address = input.address?.trim();
      if (!name && !address) {
        return JSON.stringify({
          found: false,
          message: "Provide an ENS name (e.g. vitalik.eth) or an Ethereum address.",
        });
      }

      const target = name ?? address;
      let result: EnsLookupResult;
      try {
        result = name
          ? await ens.lookup({ kind: "name", name })
          : await ens.lookup({
              kind: "address",
              address: address as string,
              limit: input.limit,
            });
      } catch (err) {
        // LangGraph turns a thrown tool error into a ToolMessage, so log here
        // or the failure never reaches the app logs.
        const reason = err instanceof Error ? err.message : String(err);
        logger.error(
          `ENS lookup failed for "${target}": ${reason}`,
          err instanceof Error ? err.stack : undefined,
        );
        return JSON.stringify({
          found: false,
          error: reason,
          message:
            "The ENS lookup failed. Tell the user the ENS data source is unavailable; do not invent an answer.",
        });
      }

      if (result.domains.length === 0) {
        return JSON.stringify({
          found: false,
          message: name
            ? `No ENS domain found for "${name}"`
            : `No ENS domains found for ${address}`,
        });
      }
      return JSON.stringify({
        found: true,
        ...result,
        domains: result.domains.map((d) => localizeDates(d, toLocalIso)),
      });
    },
    {
      name: "lookup_ens",
      description:
        `Look up Ethereum Name Service (ENS) records on ${networkLabel} via The Graph. Use for name → address, address → names, owners, expiry, and recent transfers. Not for prices or other chains. Dates are ISO 8601 already converted to the user's local time zone, offset included: report expiryDate and gracePeriodEndDate exactly as given, never shift them and never compute one from the other.`,
      schema: inputSchema,
    },
  );
}

/** The port speaks UTC; the user reads local time, so convert at this boundary. */
function localizeDates(
  domain: EnsDomainRecord,
  toLocalIso: IsoZoneFormatter,
): EnsDomainRecord {
  return {
    ...domain,
    createdAt: domain.createdAt && toLocalIso(domain.createdAt),
    expiryDate: domain.expiryDate && toLocalIso(domain.expiryDate),
    gracePeriodEndDate:
      domain.gracePeriodEndDate && toLocalIso(domain.gracePeriodEndDate),
  };
}
