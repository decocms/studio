import { describe, expect, it } from "bun:test";
import { EntitlementsFetchError } from "../ai-providers/adapters/deco-ai-gateway";
import {
  evictExpiredPlanStateEntries,
  isFeatureAllowed,
  isUsageBlocked,
  refreshPlanStateCacheEntry,
} from "./plan-feature-gate";

describe("isFeatureAllowed", () => {
  it("denies an absent key — absent means denied, not unknown", () => {
    expect(isFeatureAllowed({ cms: true }, "kanban")).toBe(false);
  });

  it("denies an explicit false", () => {
    expect(isFeatureAllowed({ kanban: false }, "kanban")).toBe(false);
  });

  it("allows only an explicit true", () => {
    expect(isFeatureAllowed({ kanban: true }, "kanban")).toBe(true);
  });

  it("FAILS OPEN when the gateway has no answer at all", () => {
    // A gateway outage must not lock every tenant out of its own CMS; the
    // spend is metered by the gateway regardless of what this returns.
    expect(isFeatureAllowed(null, "cms")).toBe(true);
    expect(isFeatureAllowed(null, "model_choice")).toBe(true);
  });

  it("does not treat a truthy non-boolean as granted", () => {
    expect(
      isFeatureAllowed(
        { cms: "yes" } as unknown as Record<string, boolean>,
        "cms",
      ),
    ).toBe(false);
  });
});

describe("isUsageBlocked", () => {
  it("stops an exhausted bar with an empty wallet", () => {
    expect(isUsageBlocked("exhausted", 0)).toBe(true);
    expect(isUsageBlocked("exhausted", null)).toBe(true);
  });

  it("lets ok and warn through", () => {
    expect(isUsageBlocked("ok", 0)).toBe(false);
    expect(isUsageBlocked("warn", 0)).toBe(false);
  });

  it("treats an unread bar as unknown, never as exhausted", () => {
    // `usage: null` means the gateway could not read consumption. Stopping a
    // paying org's chat on a failed read is the worse bug. It is also what a
    // plans-disabled deployment produces, which is why there is no second
    // enforcement flag to check here.
    expect(isUsageBlocked(null, 0)).toBe(false);
  });

  it("does NOT stop an exhausted bar that still has wallet credit", () => {
    // The bar is the plan's envelope and money cannot move it — but credits
    // are spendable and fund the provider key, so refusing here would deny
    // work the gateway would meter, right after telling the org to top up.
    expect(isUsageBlocked("exhausted", 25)).toBe(false);
    expect(isUsageBlocked("exhausted", 0.01)).toBe(false);
  });

  it("does not treat negative credit (debt) as spendable", () => {
    expect(isUsageBlocked("exhausted", -5)).toBe(true);
  });
});

describe("planStateCache bounds", () => {
  const state = {
    features: {},
    modelPins: null,
    usageState: null,
    creditsUsd: null,
  };
  const mk = (n: number, at = Date.now()) => {
    const c = new Map<string, { state: typeof state; at: number }>();
    for (let i = 0; i < n; i++) c.set(`org_${i}`, { state, at });
    return c;
  };

  it("leaves a cache at or under the cap alone", () => {
    const c = mk(10);
    evictExpiredPlanStateEntries(c, 10, 60_000);
    expect(c.size).toBe(10);
  });

  it("drops expired entries first once over the cap", () => {
    const c = mk(12, Date.now() - 120_000); // all stale
    evictExpiredPlanStateEntries(c, 10, 60_000);
    expect(c.size).toBe(0);
  });

  it("trims oldest-first down to the cap when nothing is expired", () => {
    const c = mk(13);
    evictExpiredPlanStateEntries(c, 10, 60_000);
    expect(c.size).toBe(10);
    // org_0..org_2 were the oldest three inserted.
    expect(c.has("org_0")).toBe(false);
    expect(c.has("org_2")).toBe(false);
    expect(c.has("org_3")).toBe(true);
    expect(c.has("org_12")).toBe(true);
  });

  it("a refreshed hot org moves to the newest position, so it is not evicted first", () => {
    const c = mk(11);
    refreshPlanStateCacheEntry(c, "org_0", state); // org_0 is hot
    evictExpiredPlanStateEntries(c, 10, 60_000);
    // Plain Map.set would have kept org_0 first in line and dropped it.
    expect(c.has("org_0")).toBe(true);
    expect(c.has("org_1")).toBe(false);
  });
});

describe("EntitlementsFetchError.isDefinitive", () => {
  it("treats a 4xx as definitive — a reachable gateway that refused", () => {
    for (const status of [400, 401, 403, 404, 422, 499]) {
      expect(new EntitlementsFetchError(status).isDefinitive).toBe(true);
    }
  });

  it("treats a 5xx as an outage, which is a different incident", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(new EntitlementsFetchError(status).isDefinitive).toBe(false);
    }
  });
});
