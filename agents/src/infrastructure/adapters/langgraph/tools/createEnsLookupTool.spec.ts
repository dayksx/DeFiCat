import { describe, expect, it } from "vitest";
import { EnsLookupError } from "../../../../app/ports/graph/EnsLookupPort.js";
import type {
  EnsLookupPort,
  EnsLookupQuery,
  EnsLookupResult,
} from "../../../../app/ports/graph/EnsLookupPort.js";
import { createEnsLookupTool } from "./createEnsLookupTool.js";

class FakeEns implements EnsLookupPort {
  last: EnsLookupQuery | undefined;
  result: EnsLookupResult = { domains: [], transfers: [] };
  failure: Error | undefined;

  async lookup(query: EnsLookupQuery): Promise<EnsLookupResult> {
    this.last = query;
    if (this.failure !== undefined) throw this.failure;
    return this.result;
  }
}

describe("createEnsLookupTool", () => {
  it("looks up by name", async () => {
    const ens = new FakeEns();
    ens.result = {
      domains: [
        {
          name: "vitalik.eth",
          labelName: "vitalik",
          labelhash: "0x1",
          owner: "0xowner",
          registrant: null,
          wrappedOwner: null,
          resolvedAddress: "0xaddr",
          createdAt: "1",
          expiryDate: "2",
        },
      ],
      transfers: [],
    };
    const t = createEnsLookupTool(ens);
    const raw = await t.invoke({ name: "vitalik.eth" });
    const parsed = JSON.parse(raw as string) as { found: boolean };
    expect(ens.last).toEqual({ kind: "name", name: "vitalik.eth" });
    expect(parsed.found).toBe(true);
  });

  it("returns found false when empty", async () => {
    const ens = new FakeEns();
    const t = createEnsLookupTool(ens);
    const raw = await t.invoke({ address: "0xabc" });
    expect(JSON.parse(raw as string)).toMatchObject({ found: false });
  });

  it("reports a lookup failure instead of throwing", async () => {
    const ens = new FakeEns();
    ens.failure = new EnsLookupError(
      "The Graph rejected THEGRAPH_API_KEY: auth error: API key not found",
    );
    const t = createEnsLookupTool(ens);

    const raw = await t.invoke({ name: "dayan.eth" });

    expect(JSON.parse(raw as string)).toMatchObject({
      found: false,
      error:
        "The Graph rejected THEGRAPH_API_KEY: auth error: API key not found",
    });
  });
});
