import { describe, expect, it } from "bun:test";
import { AI_PLAN_INVOICE_UPGRADE, invoiceUpgradeRefusal } from "./plan-change";

const flagged = {
  planId: "custom",
  features: { invoice_upgrade: true },
  usageState: "exhausted" as const,
};

const allowed = {
  plansEnabled: true,
  entitlements: flagged,
  subscriptionBound: false,
  targetPlanId: "starter",
};

describe("invoiceUpgradeRefusal", () => {
  it("allows a flagged org with no subscription moving to another plan", () => {
    expect(invoiceUpgradeRefusal(allowed)).toBeNull();
  });

  it("refuses until the usage bar is full, and when usage is unknown", () => {
    for (const usageState of ["ok", "warn", null] as const) {
      expect(
        invoiceUpgradeRefusal({
          ...allowed,
          entitlements: { ...flagged, usageState },
        }),
      ).not.toBeNull();
    }
  });

  it("refuses when plans are off", () => {
    expect(
      invoiceUpgradeRefusal({ ...allowed, plansEnabled: false }),
    ).not.toBeNull();
  });

  it("refuses when the gateway gave no answer", () => {
    expect(
      invoiceUpgradeRefusal({ ...allowed, entitlements: null }),
    ).not.toBeNull();
  });

  it("refuses when the flag is absent or not exactly true", () => {
    const cases: Record<string, boolean>[] = [
      {},
      { invoice_upgrade: false },
      { cms: true },
    ];
    for (const features of cases) {
      expect(
        invoiceUpgradeRefusal({
          ...allowed,
          entitlements: { ...flagged, features },
        }),
      ).not.toBeNull();
    }
  });

  it("refuses while a Stripe subscription is bound", () => {
    expect(
      invoiceUpgradeRefusal({ ...allowed, subscriptionBound: true }),
    ).not.toBeNull();
  });

  it("refuses moving to the plan the org is already on", () => {
    expect(
      invoiceUpgradeRefusal({
        ...allowed,
        entitlements: { ...flagged, planId: "starter" },
      }),
    ).not.toBeNull();
  });
});

describe("AI_PLAN_INVOICE_UPGRADE input validation", () => {
  it("accepts only the self-serve paid plans", () => {
    for (const planId of ["starter", "business"]) {
      expect(
        AI_PLAN_INVOICE_UPGRADE.inputSchema.safeParse({ planId }).success,
      ).toBe(true);
    }
    for (const planId of ["free", "custom", "ai_service", "", undefined]) {
      expect(
        AI_PLAN_INVOICE_UPGRADE.inputSchema.safeParse({ planId }).success,
      ).toBe(false);
    }
  });
});
