import { describe, expect, it } from "vitest";
import {
  TheGraphEnsAdapter,
  type GraphQlRequester,
} from "./TheGraphEnsAdapter.js";

class FakeGraph implements GraphQlRequester {
  calls: Array<{ document: string; variables?: Record<string, unknown> }> = [];
  responses: unknown[] = [];
  failure: unknown;

  request<T>(
    document: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    this.calls.push({ document, variables });
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error("FakeGraph: no queued response");
    }
    return Promise.resolve(next as T);
  }
}

describe("TheGraphEnsAdapter", () => {
  it("looks up a domain by name and recent transfers", async () => {
    const graph = new FakeGraph();
    graph.responses.push(
      {
        domains: [
          {
            id: "0xabc",
            name: "vitalik.eth",
            labelName: "vitalik",
            labelhash: "0xlab",
            createdAt: "1623530779",
            expiryDate: "1789091539",
            registration: { expiryDate: "1781315539" },
            owner: { id: "0xowner" },
            registrant: { id: "0xreg" },
            wrappedOwner: null,
            resolvedAddress: { id: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" },
          },
        ],
      },
      {
        transfers: [
          {
            id: "t1",
            blockNumber: 10,
            transactionID: "0xtx",
            owner: { id: "0xowner" },
            domain: { id: "0xabc" },
          },
        ],
      },
    );
    const adapter = new TheGraphEnsAdapter(graph);

    const result = await adapter.lookup({ kind: "name", name: "Vitalik.ETH" });

    expect(graph.calls[0]?.variables).toEqual({ name: "vitalik.eth" });
    expect(result.domains[0]?.resolvedAddress).toBe(
      "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
    );
    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]?.transactionId).toBe("0xtx");
  });

  it("reads expiry from the registration and keeps the domain date as the grace period end", async () => {
    const graph = new FakeGraph();
    graph.responses.push(
      {
        domains: [
          {
            id: "0xabc",
            name: "dayan.eth",
            createdAt: "1623530779",
            expiryDate: "1789091539",
            registration: { expiryDate: "1781315539" },
          },
        ],
      },
      { transfers: [] },
    );
    const adapter = new TheGraphEnsAdapter(graph);

    const result = await adapter.lookup({ kind: "name", name: "dayan.eth" });

    expect(result.domains[0]).toMatchObject({
      createdAt: "2021-06-12T20:46:19.000Z",
      expiryDate: "2026-06-13T01:52:19.000Z",
      gracePeriodEndDate: "2026-09-11T01:52:19.000Z",
    });
  });

  it("leaves dates null for a subdomain, which has no registration", async () => {
    const graph = new FakeGraph();
    graph.responses.push(
      {
        domains: [
          {
            id: "0xabc",
            name: "alice.wallet.eth",
            createdAt: "1623530779",
            expiryDate: null,
            registration: null,
          },
        ],
      },
      { transfers: [] },
    );
    const adapter = new TheGraphEnsAdapter(graph);

    const result = await adapter.lookup({
      kind: "name",
      name: "alice.wallet.eth",
    });

    expect(result.domains[0]).toMatchObject({
      expiryDate: null,
      gracePeriodEndDate: null,
    });
  });

  it("merges owned and reverse-resolved domains for an address", async () => {
    const graph = new FakeGraph();
    graph.responses.push({
      account: {
        domains: [
          {
            name: "alice.eth",
            labelName: "alice",
            labelhash: "0x1",
            owner: { id: "0xabc" },
          },
        ],
      },
      resolved: [
        {
          name: "alice.eth",
          labelName: "alice",
          labelhash: "0x1",
          owner: { id: "0xabc" },
        },
        {
          name: "alice.wallet.eth",
          labelName: "alice",
          labelhash: "0x2",
          resolvedAddress: { id: "0xabc" },
        },
      ],
    });
    const adapter = new TheGraphEnsAdapter(graph);

    const result = await adapter.lookup({
      kind: "address",
      address: "0xABC",
      limit: 5,
    });

    expect(graph.calls[0]?.variables).toEqual({
      id: "0xabc",
      address: "0xabc",
      first: 5,
    });
    expect(result.domains.map((d) => d.name)).toEqual([
      "alice.eth",
      "alice.wallet.eth",
    ]);
    expect(result.transfers).toEqual([]);
  });

  it("turns a gateway auth failure into a readable EnsLookupError", async () => {
    const graph = new FakeGraph();
    graph.failure = Object.assign(
      new Error("auth error: API key not found: {huge json dump}"),
      {
        response: {
          errors: [{ message: "auth error: API key not found" }],
          status: 200,
        },
      },
    );
    const adapter = new TheGraphEnsAdapter(graph);

    await expect(
      adapter.lookup({ kind: "name", name: "dayan.eth" }),
    ).rejects.toMatchObject({
      name: "EnsLookupError",
      message:
        "The Graph rejected THEGRAPH_API_KEY: auth error: API key not found",
    });
  });
});
