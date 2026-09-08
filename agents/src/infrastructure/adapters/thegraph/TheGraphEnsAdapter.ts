import { GraphQLClient } from "graphql-request";
import { EnsLookupError } from "../../../app/ports/graph/EnsLookupPort.js";
import type {
  EnsDomainRecord,
  EnsLookupPort,
  EnsLookupQuery,
  EnsLookupResult,
  EnsTransferRecord,
} from "../../../app/ports/graph/EnsLookupPort.js";

export const ENS_SUBGRAPH_ID =
  "5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH";

export const ENS_SUBGRAPH_URL = `https://gateway.thegraph.com/api/subgraphs/id/${ENS_SUBGRAPH_ID}`;

const DOMAIN_FIELDS = `
  id
  name
  labelName
  labelhash
  createdAt
  expiryDate
  owner { id }
  registrant { id }
  wrappedOwner { id }
  resolvedAddress { id }
`;

const DOMAIN_BY_NAME = `
  query DomainByName($name: String!) {
    domains(where: { name: $name }, first: 1) {
      ${DOMAIN_FIELDS}
    }
  }
`;

const TRANSFERS_BY_DOMAIN = `
  query TransfersByDomain($domainId: String!, $first: Int!) {
    transfers(
      first: $first
      orderBy: blockNumber
      orderDirection: desc
      where: { domain: $domainId }
    ) {
      id
      blockNumber
      transactionID
      owner { id }
      domain { id }
    }
  }
`;

/** `account(id:)` takes an ID, the domain filter takes a String: two variables. */
const ACCOUNT_DOMAINS = `
  query AccountDomains($id: ID!, $address: String!, $first: Int!) {
    account(id: $id) {
      domains(first: $first) {
        ${DOMAIN_FIELDS}
      }
    }
    resolved: domains(
      where: { resolvedAddress: $address }
      first: $first
    ) {
      ${DOMAIN_FIELDS}
    }
  }
`;

type AccountRef = { id: string } | null | undefined;

type GraphDomain = {
  id?: string;
  name?: string | null;
  labelName?: string | null;
  labelhash?: string | null;
  createdAt?: string | null;
  expiryDate?: string | null;
  owner?: AccountRef;
  registrant?: AccountRef;
  wrappedOwner?: AccountRef;
  resolvedAddress?: AccountRef;
};

type GraphTransfer = {
  id: string;
  blockNumber: number;
  transactionID: string;
  owner?: AccountRef;
  domain?: { id: string };
};

export type GraphQlRequester = {
  request: <T>(
    document: string,
    variables?: Record<string, unknown>,
  ) => Promise<T>;
};

export class TheGraphEnsAdapter implements EnsLookupPort {
  constructor(private readonly client: GraphQlRequester) {}

  static create(opts: {
    apiKey: string;
    endpoint?: string;
  }): TheGraphEnsAdapter {
    const client = new GraphQLClient(opts.endpoint ?? ENS_SUBGRAPH_URL, {
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
      },
    });
    return new TheGraphEnsAdapter({
      request: (document, variables) => client.request(document, variables),
    });
  }

  async lookup(query: EnsLookupQuery): Promise<EnsLookupResult> {
    if (query.kind === "name") {
      return this.lookupByName(query.name);
    }
    return this.lookupByAddress(query.address, query.limit ?? 10);
  }

  private async lookupByName(rawName: string): Promise<EnsLookupResult> {
    const name = rawName.trim().toLowerCase();
    const data = await this.request<{ domains: GraphDomain[] }>(
      DOMAIN_BY_NAME,
      { name },
    );
    const domains = (data.domains ?? []).map(mapDomain);
    const firstId = data.domains?.[0]?.id;
    if (firstId === undefined) {
      return { domains, transfers: [] };
    }
    const transferData = await this.request<{
      transfers: GraphTransfer[];
    }>(TRANSFERS_BY_DOMAIN, { domainId: firstId, first: 5 });
    return {
      domains,
      transfers: (transferData.transfers ?? []).map(mapTransfer),
    };
  }

  private async lookupByAddress(
    rawAddress: string,
    limit: number,
  ): Promise<EnsLookupResult> {
    const id = rawAddress.trim().toLowerCase();
    const first = Math.min(Math.max(limit, 1), 20);
    const data = await this.request<{
      account: { domains: GraphDomain[] } | null;
      resolved: GraphDomain[];
    }>(ACCOUNT_DOMAINS, { id, address: id, first });
    const owned = data.account?.domains ?? [];
    const resolved = data.resolved ?? [];
    return {
      domains: dedupeDomains([...owned, ...resolved].map(mapDomain)),
      transfers: [],
    };
  }

  private async request<T>(
    document: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await this.client.request<T>(document, variables);
    } catch (err) {
      throw new EnsLookupError(describeGraphFailure(err), { cause: err });
    }
  }
}

/** The Graph answers 200 with a GraphQL `errors` array, so unwrap it here. */
function describeGraphFailure(err: unknown): string {
  const messages = graphErrorMessages(err);
  if (messages.length === 0) {
    return `The Graph request failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  const detail = messages.join("; ");
  if (detail.toLowerCase().includes("api key")) {
    return `The Graph rejected THEGRAPH_API_KEY: ${detail}`;
  }
  return `The Graph request failed: ${detail}`;
}

function graphErrorMessages(err: unknown): string[] {
  if (typeof err !== "object" || err === null) return [];
  const response = (err as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return [];
  const errors = (response as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((e) =>
      typeof e === "object" && e !== null && "message" in e
        ? String((e as { message: unknown }).message)
        : "",
    )
    .filter((m) => m !== "");
}

function mapDomain(d: GraphDomain): EnsDomainRecord {
  return {
    name: d.name ?? null,
    labelName: d.labelName ?? null,
    labelhash: d.labelhash ?? null,
    owner: d.owner?.id ?? null,
    registrant: d.registrant?.id ?? null,
    wrappedOwner: d.wrappedOwner?.id ?? null,
    resolvedAddress: d.resolvedAddress?.id ?? null,
    createdAt: d.createdAt ?? null,
    expiryDate: d.expiryDate ?? null,
  };
}

function mapTransfer(t: GraphTransfer): EnsTransferRecord {
  return {
    id: t.id,
    domainId: t.domain?.id ?? "",
    owner: t.owner?.id ?? null,
    blockNumber: t.blockNumber,
    transactionId: t.transactionID,
  };
}

function dedupeDomains(domains: EnsDomainRecord[]): EnsDomainRecord[] {
  const seen = new Set<string>();
  const out: EnsDomainRecord[] = [];
  for (const d of domains) {
    const key = d.name ?? d.labelhash ?? JSON.stringify(d);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}
