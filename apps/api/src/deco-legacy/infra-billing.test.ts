import { describe, expect, it } from "bun:test";
import { monthInterval, nextBillingDate, planTypeOf } from "./infra-billing";

describe("monthInterval", () => {
  it("spans the full UTC month", () => {
    expect(monthInterval(new Date("2026-03-17T22:00:00Z"))).toEqual({
      since: "2026-03-01",
      until: "2026-03-31",
    });
  });

  it("handles february in a leap year", () => {
    expect(monthInterval(new Date("2024-02-05T00:00:00Z"))).toEqual({
      since: "2024-02-01",
      until: "2024-02-29",
    });
  });

  it("does not roll into the next year on december", () => {
    expect(monthInterval(new Date("2025-12-31T23:59:59Z"))).toEqual({
      since: "2025-12-01",
      until: "2025-12-31",
    });
  });
});

describe("planTypeOf", () => {
  it("is free without a subscription row", () => {
    expect(planTypeOf(undefined)).toBe("free");
    expect(planTypeOf({ plan: null, status: "Live" })).toBe("free");
  });

  it("maps live pro and enterprise plans", () => {
    expect(planTypeOf({ plan: 5, status: "Live" })).toBe("pro");
    expect(planTypeOf({ plan: 6, status: "Live" })).toBe("enterprise");
  });

  it("downgrades a paid plan that is no longer live", () => {
    expect(planTypeOf({ plan: 5, status: "Churned" })).toBe("free");
    expect(planTypeOf({ plan: 6, status: null })).toBe("free");
  });

  it("keeps full access regardless of status", () => {
    expect(planTypeOf({ plan: 420, status: "Churned" })).toBe("enterprise");
  });

  it("treats an unknown plan id as free", () => {
    expect(planTypeOf({ plan: 99, status: "Live" })).toBe("free");
  });
});

describe("nextBillingDate", () => {
  const now = new Date("2026-08-16T12:00:00Z");

  it("bills enterprise on the first of next month", () => {
    expect(nextBillingDate("enterprise", undefined, now)).toBe("2026-09-01");
  });

  it("rolls the enterprise date into the next year from december", () => {
    expect(
      nextBillingDate(
        "enterprise",
        undefined,
        new Date("2026-12-31T00:00:00Z"),
      ),
    ).toBe("2027-01-01");
  });

  it("uses the stripe period end for paid non-enterprise plans", () => {
    const periodEnd = Math.floor(Date.UTC(2026, 8, 3) / 1000);
    expect(nextBillingDate("pro", periodEnd, now)).toBe("2026-09-03");
  });

  it("has no date when stripe schedules nothing", () => {
    expect(nextBillingDate("pro", undefined, now)).toBeNull();
    expect(nextBillingDate("free", undefined, now)).toBeNull();
  });
});
