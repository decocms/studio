/**
 * Unit test for the org-archived-status cache's eviction: without a bound,
 * every org id ever seen stays in the map forever (a stale entry is only
 * ever overwritten on its own next lookup, never dropped otherwise).
 */
import { describe, expect, it } from "bun:test";
import {
  evictExpiredOrgArchivedEntries,
  refreshOrgArchivedCacheEntry,
} from "./context-factory";

describe("evictExpiredOrgArchivedEntries", () => {
  it("leaves the cache untouched when under the cap", () => {
    const cache = new Map([["org_1", { archived: false, at: Date.now() }]]);
    evictExpiredOrgArchivedEntries(cache, 10, 60_000);
    expect(cache.size).toBe(1);
  });

  it("drops expired entries first when over the cap", () => {
    const now = Date.now();
    const cache = new Map([
      ["org_stale", { archived: false, at: now - 120_000 }],
      ["org_fresh", { archived: false, at: now }],
    ]);
    evictExpiredOrgArchivedEntries(cache, 1, 60_000);
    expect(cache.has("org_stale")).toBe(false);
    expect(cache.has("org_fresh")).toBe(true);
  });

  it("trims the oldest entries when still over the cap after expiry", () => {
    const now = Date.now();
    const cache = new Map([
      ["org_a", { archived: false, at: now }],
      ["org_b", { archived: false, at: now }],
      ["org_c", { archived: false, at: now }],
    ]);
    evictExpiredOrgArchivedEntries(cache, 1, 60_000);
    expect(cache.size).toBe(1);
    expect(cache.has("org_c")).toBe(true);
  });
});

describe("refreshOrgArchivedCacheEntry", () => {
  it("moves a re-looked-up org past older untouched ones, so a hot org isn't the first evicted", () => {
    const cache = new Map<string, { archived: boolean; at: number }>();
    refreshOrgArchivedCacheEntry(cache, "org_a", false);
    refreshOrgArchivedCacheEntry(cache, "org_b", false);
    refreshOrgArchivedCacheEntry(cache, "org_c", false);
    // org_a is looked up again — same key, but it's the hot one now.
    refreshOrgArchivedCacheEntry(cache, "org_a", false);

    evictExpiredOrgArchivedEntries(cache, 2, 60_000);

    expect(cache.has("org_b")).toBe(false);
    expect(cache.has("org_a")).toBe(true);
    expect(cache.has("org_c")).toBe(true);
  });
});
