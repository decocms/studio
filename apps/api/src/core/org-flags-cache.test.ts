/**
 * Unit test for the org-flags cache's eviction: without a bound, every org id
 * ever seen stays in the map forever (a stale entry is only ever overwritten
 * on its own next lookup, never dropped otherwise).
 */
import { describe, expect, it } from "bun:test";
import type { OrgFlags } from "./org-flags-cache";
import {
  evictExpiredOrgFlagsEntries,
  invalidateOrgFlagsCache,
  orgFlagsCached,
  refreshOrgFlagsCacheEntry,
} from "./org-flags-cache";

describe("evictExpiredOrgFlagsEntries", () => {
  it("leaves the cache untouched when under the cap", () => {
    const cache = new Map([["org_1", { value: null, at: Date.now() }]]);
    evictExpiredOrgFlagsEntries(cache, 10, 60_000);
    expect(cache.size).toBe(1);
  });

  it("drops expired entries first when over the cap", () => {
    const now = Date.now();
    const cache = new Map([
      ["org_stale", { value: null, at: now - 120_000 }],
      ["org_fresh", { value: null, at: now }],
    ]);
    evictExpiredOrgFlagsEntries(cache, 1, 60_000);
    expect(cache.has("org_stale")).toBe(false);
    expect(cache.has("org_fresh")).toBe(true);
  });

  it("trims the oldest entries when still over the cap after expiry", () => {
    const now = Date.now();
    const cache = new Map([
      ["org_a", { value: null, at: now }],
      ["org_b", { value: null, at: now }],
      ["org_c", { value: null, at: now }],
    ]);
    evictExpiredOrgFlagsEntries(cache, 1, 60_000);
    expect(cache.size).toBe(1);
    expect(cache.has("org_c")).toBe(true);
  });
});

describe("refreshOrgFlagsCacheEntry", () => {
  it("moves a refreshed org to the most-recent position", () => {
    const cache = new Map<string, { value: OrgFlags; at: number }>([
      ["org_a", { value: null, at: 1 }],
      ["org_b", { value: null, at: 1 }],
    ]);
    refreshOrgFlagsCacheEntry(cache, "org_a", { demo_mode: true });
    expect([...cache.keys()]).toEqual(["org_b", "org_a"]);
    expect(cache.get("org_a")?.value).toEqual({ demo_mode: true });
  });
});

describe("orgFlagsCached", () => {
  /** Counts the reads the cache lets through. */
  const ctxReading = (flags: Record<string, unknown> | null) => {
    let reads = 0;
    return {
      reads: () => reads,
      ctx: {
        storage: {
          organizationSettings: {
            get: async () => {
              reads++;
              return flags === null ? null : { flags };
            },
          },
        },
      } as never,
    };
  };

  it("reads once per org until the entry is dropped", async () => {
    const org = `org_${crypto.randomUUID()}`;
    const { ctx, reads } = ctxReading({ demo_mode: true });
    expect(await orgFlagsCached(ctx, org)).toEqual({ demo_mode: true });
    expect(await orgFlagsCached(ctx, org)).toEqual({ demo_mode: true });
    expect(reads()).toBe(1);

    invalidateOrgFlagsCache(org);
    expect(await orgFlagsCached(ctx, org)).toEqual({ demo_mode: true });
    expect(reads()).toBe(2);
  });

  it("caches an org with no settings row as having no flags", async () => {
    const org = `org_${crypto.randomUUID()}`;
    const { ctx, reads } = ctxReading(null);
    expect(await orgFlagsCached(ctx, org)).toBeNull();
    expect(await orgFlagsCached(ctx, org)).toBeNull();
    expect(reads()).toBe(1);
  });

  it("answers no flags when the read fails, rather than throwing", async () => {
    const ctx = {
      storage: {
        organizationSettings: {
          get: async () => {
            throw new Error("db down");
          },
        },
      },
    } as never;
    expect(await orgFlagsCached(ctx, `org_${crypto.randomUUID()}`)).toBeNull();
  });
});
