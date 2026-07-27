import { describe, expect, test } from "bun:test";
import {
  finalizeNonBindingPage,
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
