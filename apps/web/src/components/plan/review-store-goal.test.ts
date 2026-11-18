import { describe, expect, it } from "bun:test";
import type { StoreSnapshot } from "@decocms/shared/organization/schema";
import { reviewStoreGoal } from "./review-store-goal.ts";

const snapshot = {} as StoreSnapshot;
const decided = (goal: "traffic_growth" | "mobile_conversion") => ({
  decision: { goal, probability: 0.8, snapshot },
});
const saved = {
  statement: "Win back visitors.",
  updated_by: "user-1",
  updated_at: "2026-08-01T00:00:00.000Z",
};

describe("reviewStoreGoal", () => {
  it("keeps the goal Jev picked before", () => {
    expect(
      reviewStoreGoal(
        { ...saved, source: "jev", goal: "traffic_growth" },
        decided("traffic_growth"),
      ),
    ).toEqual({ kind: "same" });
  });

  it("writes a different goal over Jev's", () => {
    expect(
      reviewStoreGoal(
        { ...saved, source: "jev", goal: "traffic_growth" },
        decided("mobile_conversion"),
      ),
    ).toEqual({ kind: "write", goal: "mobile_conversion" });
  });

  it("writes Jev's goal over one a member wrote, or over none", () => {
    expect(
      reviewStoreGoal(
        { ...saved, source: "member" },
        decided("traffic_growth"),
      ),
    ).toEqual({ kind: "write", goal: "traffic_growth" });
    expect(reviewStoreGoal(saved, decided("traffic_growth"))).toEqual({
      kind: "write",
      goal: "traffic_growth",
    });
    expect(reviewStoreGoal(null, decided("traffic_growth"))).toEqual({
      kind: "write",
      goal: "traffic_growth",
    });
  });

  it("keeps what is saved when Jev has no goal", () => {
    for (const reason of ["no_data", "unavailable", "uncertain"] as const) {
      expect(reviewStoreGoal(saved, { decision: null, reason })).toEqual({
        kind: "none",
        reason,
      });
    }
    expect(reviewStoreGoal(saved, { decision: null })).toEqual({
      kind: "none",
      reason: "unavailable",
    });
  });
});
