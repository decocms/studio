import { describe, expect, it } from "bun:test";
import { WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import {
  extractItemsFromResponse,
  flattenPaginatedItems,
  getConnectionTypeLabel,
  inferRegistryListToolName,
} from "./registry-utils";

describe("inferRegistryListToolName", () => {
  it("uses the collection list tool for well-known registries", () => {
    const orgId = "org_1";
    expect(
      inferRegistryListToolName(WellKnownOrgMCPId.REGISTRY(orgId), orgId),
    ).toBe("COLLECTION_REGISTRY_APP_LIST");
    expect(
      inferRegistryListToolName(
        WellKnownOrgMCPId.COMMUNITY_REGISTRY(orgId),
        orgId,
      ),
    ).toBe("COLLECTION_REGISTRY_APP_LIST");
  });

  it("uses the private registry item tool for anything else", () => {
    expect(inferRegistryListToolName("conn_abc123", "org_1")).toBe(
      "REGISTRY_ITEM_LIST",
    );
  });

  it("does not match a well-known id from a different org", () => {
    expect(
      inferRegistryListToolName(WellKnownOrgMCPId.REGISTRY("org_1"), "org_2"),
    ).toBe("REGISTRY_ITEM_LIST");
  });
});

describe("flattenPaginatedItems", () => {
  it("returns an empty array when no pages are given", () => {
    expect(flattenPaginatedItems(undefined)).toEqual([]);
  });

  it("flattens pages that are plain arrays", () => {
    expect(flattenPaginatedItems([[1, 2], [3]])).toEqual([1, 2, 3]);
  });

  it("flattens pages shaped as objects with a nested array field", () => {
    expect(flattenPaginatedItems([{ items: [1, 2] }, { items: [3] }])).toEqual([
      1, 2, 3,
    ]);
  });

  it("skips pages with no array field", () => {
    expect(flattenPaginatedItems([{ items: [1] }, { total: 5 }])).toEqual([1]);
  });
});

describe("getConnectionTypeLabel", () => {
  it("returns null when no type is given", () => {
    expect(getConnectionTypeLabel(undefined)).toBeNull();
  });

  it("maps known types to human-readable labels", () => {
    expect(getConnectionTypeLabel("streamable-http")).toBe("HTTP");
    expect(getConnectionTypeLabel("sse")).toBe("SSE");
  });

  it("uppercases unknown types instead of dropping them", () => {
    expect(getConnectionTypeLabel("custom")).toBe("CUSTOM");
  });
});

describe("extractItemsFromResponse", () => {
  it("returns an empty array for nullish responses", () => {
    expect(extractItemsFromResponse(null)).toEqual([]);
    expect(extractItemsFromResponse(undefined)).toEqual([]);
  });

  it("returns direct array responses as-is", () => {
    expect(extractItemsFromResponse([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("extracts the first array field from an object response", () => {
    expect(extractItemsFromResponse({ total: 2, items: [1, 2] })).toEqual([
      1, 2,
    ]);
  });

  it("returns an empty array when the object has no array field", () => {
    expect(extractItemsFromResponse({ total: 2 })).toEqual([]);
  });
});
