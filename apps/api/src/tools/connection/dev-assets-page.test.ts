import { describe, expect, test } from "bun:test";
import {
  finalizeNonBindingPage,
  resolveDevAssetsSqlWindow,
  shouldConsiderDevAssetsForPage,
} from "./dev-assets-page";

describe("shouldConsiderDevAssetsForPage", () => {
  test("considers it on the first page of a plain listing", () => {
    expect(shouldConsiderDevAssetsForPage(false, 0)).toBe(true);
  });

  test("skips it on later pages of a plain listing", () => {
    expect(shouldConsiderDevAssetsForPage(false, 100)).toBe(false);
  });

  test("always considers it when binding-filtering (pagination happens after)", () => {
    expect(shouldConsiderDevAssetsForPage(true, 100)).toBe(true);
  });
});

describe("finalizeNonBindingPage", () => {
  test("passes through unchanged when nothing was injected", () => {
    const connections = [1, 2, 3];
    const result = finalizeNonBindingPage(connections, false, 100, 0, 3);
    expect(result).toEqual({ items: [1, 2, 3], totalCount: 3, hasMore: false });
  });

  test("trims a full SQL page back to limit and counts the extra row", () => {
    // 100 real rows already filled the page; dev-assets was unshifted on top.
    const connections = Array.from({ length: 101 }, (_, i) => i);
    const result = finalizeNonBindingPage(connections, true, 100, 0, 150);

    expect(result.items.length).toBe(100);
    expect(result.totalCount).toBe(151);
    expect(result.hasMore).toBe(true);
  });

  test("does not overcount when the injected row fits within limit", () => {
    const connections = [0, 1, 2, 3, 4]; // 4 real rows + dev-assets
    const result = finalizeNonBindingPage(connections, true, 100, 0, 4);

    expect(result.items).toEqual([0, 1, 2, 3, 4]);
    expect(result.totalCount).toBe(5);
    expect(result.hasMore).toBe(false);
  });
});

describe("resolveDevAssetsSqlWindow", () => {
  test("passes the requested window through unchanged when it doesn't qualify", () => {
    expect(resolveDevAssetsSqlWindow(100, 50, false)).toEqual({
      sqlOffset: 100,
      sqlLimit: 50,
    });
  });

  test("reserves one slot on page 1 when it qualifies", () => {
    expect(resolveDevAssetsSqlWindow(0, 100, true)).toEqual({
      sqlOffset: 0,
      sqlLimit: 99,
    });
  });

  test("never goes negative when limit is 0", () => {
    expect(resolveDevAssetsSqlWindow(0, 0, true)).toEqual({
      sqlOffset: 0,
      sqlLimit: 0,
    });
  });

  test("shifts a later page's real-row offset back by one", () => {
    expect(resolveDevAssetsSqlWindow(100, 100, true)).toEqual({
      sqlOffset: 99,
      sqlLimit: 100,
    });
  });

  test("proves no real row is lost across the page-1/page-2 boundary", () => {
    // 100 real rows, limit 100: page 1 fetches rows [0, 99) plus dev-assets.
    const page1 = resolveDevAssetsSqlWindow(0, 100, true);
    expect(page1).toEqual({ sqlOffset: 0, sqlLimit: 99 });
    // Page 2 must resume at row 99, the one page 1's synthetic slot bumped.
    const page2 = resolveDevAssetsSqlWindow(100, 100, true);
    expect(page2).toEqual({ sqlOffset: 99, sqlLimit: 100 });
  });
});
