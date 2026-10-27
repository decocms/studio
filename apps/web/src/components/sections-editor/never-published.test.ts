import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { neverPublishedBlock } from "./content-protocol-api";

const cacheKey = "acme:vm:draft";

function client(
  changes: Record<string, unknown>,
  tombstones: string[] = [],
): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(KEYS.contentChanges(cacheKey), {
    revision: "r1",
    changes,
  });
  queryClient.setQueryData(KEYS.contentDraftTombstones(cacheKey), tombstones);
  return queryClient;
}

describe("neverPublishedBlock (a deletion Publish can't list)", () => {
  it("a block the draft created (main has none) was never published", () => {
    const queryClient = client({
      "Promo-2": { kind: "set", version: "v1", baseVersion: null },
    });
    expect(neverPublishedBlock(queryClient, cacheKey, "Promo-2")).toBe(true);
  });

  it("a draft-only block the draft deletes now (its tombstone) was never published", () => {
    const queryClient = client({}, ["Promo-2"]);
    expect(neverPublishedBlock(queryClient, cacheKey, "Promo-2")).toBe(true);
  });

  it("main's block, changed, deleted or untouched, is published: its deletion is listed", () => {
    const queryClient = client({
      Header: { kind: "set", version: "v2", baseVersion: "b1" },
      Footer: { kind: "delete", version: null, baseVersion: "b2" },
    });
    expect(neverPublishedBlock(queryClient, cacheKey, "Header")).toBe(false);
    expect(neverPublishedBlock(queryClient, cacheKey, "Footer")).toBe(false);
    expect(neverPublishedBlock(queryClient, cacheKey, "Hero")).toBe(false);
  });

  it("unknown before the draft's changes were read: as before (published)", () => {
    expect(neverPublishedBlock(new QueryClient(), cacheKey, "Promo-2")).toBe(
      false,
    );
  });
});
