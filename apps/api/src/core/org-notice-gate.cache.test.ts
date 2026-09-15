/**
 * Unit test for the org-notice cache's eviction: without a bound, every org
 * id ever seen stays in the map forever (a stale entry is only ever
 * overwritten on its own next lookup, never dropped otherwise).
 */
import { describe, expect, it } from "bun:test";
import {
  evictExpiredOrgNoticeEntries,
  refreshOrgNoticeCacheEntry,
} from "./org-notice-gate";

describe("evictExpiredOrgNoticeEntries", () => {
  it("leaves the cache untouched when under the cap", () => {
    const cache = new Map([["org_1", { notice: null, at: Date.now() }]]);
    evictExpiredOrgNoticeEntries(cache, 10, 60_000);
    expect(cache.size).toBe(1);
  });

  it("drops expired entries first when over the cap", () => {
    const now = Date.now();
    const cache = new Map([
      ["org_stale", { notice: null, at: now - 120_000 }],
      ["org_fresh", { notice: null, at: now }],
    ]);
    evictExpiredOrgNoticeEntries(cache, 1, 60_000);
    expect(cache.has("org_stale")).toBe(false);
    expect(cache.has("org_fresh")).toBe(true);
  });

  it("trims the oldest entries when still over the cap after expiry", () => {
    const now = Date.now();
    const cache = new Map([
      ["org_a", { notice: null, at: now }],
      ["org_b", { notice: null, at: now }],
      ["org_c", { notice: null, at: now }],
    ]);
    evictExpiredOrgNoticeEntries(cache, 1, 60_000);
    expect(cache.size).toBe(1);
    expect(cache.has("org_c")).toBe(true);
  });
});

describe("refreshOrgNoticeCacheEntry", () => {
  it("moves a re-looked-up org past older untouched ones, so a hot org isn't the first evicted", () => {
    const cache = new Map<string, { notice: null; at: number }>();
    refreshOrgNoticeCacheEntry(cache, "org_a", null);
    refreshOrgNoticeCacheEntry(cache, "org_b", null);
    refreshOrgNoticeCacheEntry(cache, "org_c", null);
    // org_a is looked up again — same key, but it's the hot one now.
    refreshOrgNoticeCacheEntry(cache, "org_a", null);

    evictExpiredOrgNoticeEntries(cache, 2, 60_000);

    expect(cache.has("org_b")).toBe(false);
    expect(cache.has("org_a")).toBe(true);
    expect(cache.has("org_c")).toBe(true);
  });
});
