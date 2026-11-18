import { describe, expect, it } from "bun:test";
import type { StoreSnapshot } from "@decocms/shared/organization/schema";
import {
  acceptGoalDecision,
  buildGoalDecision,
  MIN_GOAL_PROBABILITY,
} from "./plan-goal-decision";

const empty: StoreSnapshot = {
  mobile_conversion_rate: null,
  desktop_conversion_rate: null,
  product_to_cart_rate: null,
  cart_to_checkout_rate: null,
  checkout_completion_rate: null,
  visitors: null,
  visitors_change: null,
  orders: null,
  orders_change: null,
  revenue_change: null,
  average_ticket: null,
  average_ticket_change: null,
  items_per_order: null,
  currency: null,
  site_errors: null,
  site_errors_per_1k_pageviews: null,
};

const full: StoreSnapshot = {
  mobile_conversion_rate: 0.8,
  desktop_conversion_rate: 2.1,
  product_to_cart_rate: 9.5,
  cart_to_checkout_rate: 48,
  checkout_completion_rate: 41.2,
  visitors: 120_000,
  visitors_change: -3.1,
  orders: 1_800,
  orders_change: -12.4,
  revenue_change: -10,
  average_ticket: 312.5,
  average_ticket_change: 1.2,
  items_per_order: 1.6,
  currency: "BRL",
  site_errors: 900,
  site_errors_per_1k_pageviews: 1.5,
};

describe("buildGoalDecision", () => {
  it("offers every goal the snapshot has numbers for", () => {
    const decision = buildGoalDecision(full);
    expect(Object.keys(decision?.questions.goal.criteria ?? {})).toEqual([
      "mobile_conversion",
      "checkout_completion",
      "cart_to_checkout",
      "product_to_cart",
      "traffic_growth",
      "recover_sales",
      "average_ticket",
      "site_stability",
    ]);
  });

  it("leaves out goals without data and drops nulls from the state", () => {
    const decision = buildGoalDecision({
      ...empty,
      checkout_completion_rate: 30,
      orders_change: -20,
      // One of the two rates alone cannot back the mobile goal.
      mobile_conversion_rate: 1,
    });
    expect(Object.keys(decision?.questions.goal.criteria ?? {})).toEqual([
      "checkout_completion",
      "recover_sales",
    ]);
    expect(decision?.state.store_last_28_days).toEqual({
      checkout_completion_rate: 30,
      orders_change: -20,
      mobile_conversion_rate: 1,
    });
  });

  it("does not ask when fewer than two goals are backed", () => {
    expect(buildGoalDecision(empty)).toBeNull();
    expect(
      buildGoalDecision({ ...empty, checkout_completion_rate: 30 }),
    ).toBeNull();
  });
});

describe("acceptGoalDecision", () => {
  const decision = buildGoalDecision(full);
  if (!decision) throw new Error("expected a decision");
  const answer = (choice: string, probability: number) => ({
    goal: {
      type: "choice",
      choice,
      probabilities: { [choice]: probability },
    },
  });

  it("accepts a confident choice from the catalog", () => {
    expect(
      acceptGoalDecision(answer("mobile_conversion", 0.82), decision.questions),
    ).toEqual({ goal: "mobile_conversion", probability: 0.82 });
    expect(
      acceptGoalDecision(
        answer("recover_sales", MIN_GOAL_PROBABILITY),
        decision.questions,
      )?.goal,
    ).toBe("recover_sales");
  });

  it("rejects a guess, an unknown option and a broken probability", () => {
    const rejected: Parameters<typeof acceptGoalDecision>[0][] = [
      answer("mobile_conversion", MIN_GOAL_PROBABILITY - 0.01),
      answer("sell_more", 0.99),
      answer("mobile_conversion", Number.NaN),
      answer("mobile_conversion", 1.2),
      { goal: { type: "score", choice: "mobile_conversion" } },
      { goal: { type: "choice", choice: "mobile_conversion" } },
      {},
    ];
    for (const answers of rejected) {
      expect(acceptGoalDecision(answers, decision.questions)).toBeNull();
    }
  });

  it("rejects a catalog goal that was not offered", () => {
    const narrow = buildGoalDecision({
      ...empty,
      checkout_completion_rate: 30,
      orders_change: -20,
    });
    if (!narrow) throw new Error("expected a decision");
    expect(
      acceptGoalDecision(answer("site_stability", 0.9), narrow.questions),
    ).toBeNull();
  });
});
