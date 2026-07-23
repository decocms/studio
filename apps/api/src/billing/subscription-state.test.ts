import { describe, expect, test } from "bun:test";
import {
  hasChargeableSubscription,
  subscriptionInGoodStanding,
} from "./subscription-state";

describe("subscriptionInGoodStanding", () => {
  test("self_serve: active and past_due (dunning grace) are good, everything else is not", () => {
    for (const status of ["active", "past_due"]) {
      expect(
        subscriptionInGoodStanding({ billingMode: "self_serve", status }),
      ).toBe(true);
    }
    for (const status of ["none", "canceled", "incomplete", ""]) {
      expect(
        subscriptionInGoodStanding({ billingMode: "self_serve", status }),
      ).toBe(false);
    }
  });

  test("invoiced orgs and missing billing rows are always in good standing", () => {
    expect(
      subscriptionInGoodStanding({ billingMode: "invoiced", status: "none" }),
    ).toBe(true);
    expect(subscriptionInGoodStanding(null)).toBe(true);
  });
});

describe("hasChargeableSubscription", () => {
  const base = {
    billingMode: "self_serve",
    status: "active",
    stripeSubscriptionId: "sub_1",
  };

  test("chargeable only when self_serve + active + a bound subscription", () => {
    expect(hasChargeableSubscription(base)).toBe(true);
    expect(hasChargeableSubscription(null)).toBe(false);
    expect(
      hasChargeableSubscription({ ...base, billingMode: "invoiced" }),
    ).toBe(false);
    expect(
      hasChargeableSubscription({ ...base, stripeSubscriptionId: null }),
    ).toBe(false);
  });

  test("past_due is NOT chargeable — good standing (grace) without stacking charges on a failing card", () => {
    const pastDue = { ...base, status: "past_due" };
    expect(subscriptionInGoodStanding(pastDue)).toBe(true);
    expect(hasChargeableSubscription(pastDue)).toBe(false);
  });
});
