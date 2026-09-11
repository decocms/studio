import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { bumpUsageOptimistically } from "./use-entitlements";

/**
 * The bar's numerator is the provider's per-key usage counter, and that counter
 * settles asynchronously — so the read right after a turn returns the PRE-turn
 * number and the bar never visibly moves. This is what moves it in the
 * meantime, and the thing it must never do is invent a number: with no
 * denominator, or with no bar at all, the cache has to come back untouched.
 */

const ORG = "org_1";

function clientWith(usage: unknown) {
  const qc = new QueryClient();
  qc.setQueryData(KEYS.aiPlanEntitlements(ORG), {
    plan: { id: "pro", name: "Pro" },
    features: { chat: true },
    usage,
    credits: null,
    tasks: { allowed: true, remaining: null, denyReason: null },
    periodStart: null,
    periodEnd: null,
  });
  return qc;
}

function usageAfter(qc: QueryClient) {
  return (
    qc.getQueryData(KEYS.aiPlanEntitlements(ORG)) as {
      usage: { percent: number; state: string; usedMicros: number } | null;
    }
  ).usage;
}

describe("bumpUsageOptimistically", () => {
  it("advances the percent by the turn's own cost", () => {
    // $10 of a $20 envelope, then a $1 turn: 55%.
    const qc = clientWith({
      percent: 0.5,
      state: "ok",
      usedMicros: 10_000_000,
      limitMicros: 20_000_000,
    });
    bumpUsageOptimistically(qc, ORG, 1);
    expect(usageAfter(qc)).toMatchObject({
      percent: 0.55,
      usedMicros: 11_000_000,
      state: "ok",
    });
  });

  it("carries the colour across a threshold with the number", () => {
    // 78% + $1 of $20 = 83%. A bar that reads 83% in the OK colour until the
    // next refetch is the two halves of one estimate disagreeing.
    const qc = clientWith({
      percent: 0.78,
      state: "ok",
      usedMicros: 15_600_000,
      limitMicros: 20_000_000,
    });
    bumpUsageOptimistically(qc, ORG, 1);
    expect(usageAfter(qc)?.state).toBe("warn");
  });

  it("clamps at a full bar rather than reporting over 100%", () => {
    const qc = clientWith({
      percent: 0.95,
      state: "warn",
      usedMicros: 19_000_000,
      limitMicros: 20_000_000,
    });
    bumpUsageOptimistically(qc, ORG, 50);
    expect(usageAfter(qc)).toMatchObject({ percent: 1, state: "exhausted" });
  });

  it("leaves an unknown bar unknown", () => {
    // `usage: null` is the gateway saying it could not read consumption. An
    // estimate on top of no baseline is a number we made up.
    const qc = clientWith(null);
    bumpUsageOptimistically(qc, ORG, 1);
    expect(usageAfter(qc)).toBeNull();
  });

  it("does nothing without a denominator", () => {
    // An older gateway omits the fields; a zero envelope (trial with no
    // deposit) cannot be divided by. Both must leave the bar alone.
    for (const limitMicros of [null, 0]) {
      const qc = clientWith({
        percent: 0,
        state: "ok",
        usedMicros: 0,
        limitMicros,
      });
      bumpUsageOptimistically(qc, ORG, 1);
      expect(usageAfter(qc)).toMatchObject({ percent: 0, usedMicros: 0 });
    }
  });

  it("does nothing for a turn that cost nothing", () => {
    const qc = clientWith({
      percent: 0.5,
      state: "ok",
      usedMicros: 10_000_000,
      limitMicros: 20_000_000,
    });
    bumpUsageOptimistically(qc, ORG, 0);
    expect(usageAfter(qc)?.percent).toBe(0.5);
  });
});
