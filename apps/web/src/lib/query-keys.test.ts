import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { KEYS, invalidateCollectionQueries } from "./query-keys";

describe("KEYS.reportAll", () => {
  test("is a prefix of KEYS.report for every lang", () => {
    // sign-in-overlay.tsx invalidates by this prefix, so it must match every variant.
    const domain = "example.com";
    const prefix = KEYS.reportAll(domain);
    const variants = [KEYS.report(domain), KEYS.report(domain, "pt-BR")];
    for (const variant of variants) {
      expect(variant.slice(0, prefix.length)).toEqual([...prefix]);
    }
  });

  test("does not match a different domain's report queries", () => {
    const prefix = KEYS.reportAll("example.com");
    const other = KEYS.report("other.com");
    expect(other.slice(0, prefix.length)).not.toEqual([...prefix]);
  });
});

describe("invalidateCollectionQueries", () => {
  test("invalidates the item and list caches built by collectionItemQueryOptions/collectionListQueryOptions", () => {
    const queryClient = new QueryClient();
    const client = {};
    const itemKey = KEYS.collectionItem(
      client,
      "conn-1",
      "",
      "ASSISTANT",
      "item-1",
    );
    const listKey = KEYS.collectionList(
      client,
      "conn-1",
      "",
      "ASSISTANT",
      "page-1",
    );
    queryClient.setQueryData(itemKey, { item: null });
    queryClient.setQueryData(listKey, { structuredContent: { items: [] } });

    invalidateCollectionQueries(queryClient, "conn-1", "ASSISTANT");

    expect(queryClient.getQueryState(itemKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
  });

  test("does not invalidate a different scope or collection", () => {
    const queryClient = new QueryClient();
    const client = {};
    const otherScope = KEYS.collectionItem(
      client,
      "conn-2",
      "",
      "ASSISTANT",
      "item-1",
    );
    const otherCollection = KEYS.collectionItem(
      client,
      "conn-1",
      "",
      "WORKFLOW",
      "item-1",
    );
    queryClient.setQueryData(otherScope, { item: null });
    queryClient.setQueryData(otherCollection, { item: null });

    invalidateCollectionQueries(queryClient, "conn-1", "ASSISTANT");

    expect(queryClient.getQueryState(otherScope)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(otherCollection)?.isInvalidated).toBe(
      false,
    );
  });
});
