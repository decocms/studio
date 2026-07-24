import { describe, expect, test } from "bun:test";
import {
  computeAllowanceMicros,
  effectivePaidSeatCount,
} from "./sync-org-benefits";

describe("computeAllowanceMicros", () => {
  test("paid seats × per-seat cents, in microdollars", () => {
    // 4 paid seats × $5 = $20/month = 20M micros (the plan's example org)
    expect(computeAllowanceMicros(4, 500)).toBe(20_000_000);
    expect(computeAllowanceMicros(1, 500)).toBe(5_000_000);
  });

  test("zero seats revokes (amount 0 is the gateway's revoke)", () => {
    expect(computeAllowanceMicros(0, 500)).toBe(0);
  });
});

describe("effectivePaidSeatCount", () => {
  test("self_serve orgs serve only in good standing (past_due is grace)", () => {
    expect(
      effectivePaidSeatCount(
        { billingMode: "self_serve", status: "active" },
        4,
      ),
    ).toBe(4);
    expect(
      effectivePaidSeatCount(
        { billingMode: "self_serve", status: "past_due" },
        4,
      ),
    ).toBe(4);
    expect(
      effectivePaidSeatCount({ billingMode: "self_serve", status: "none" }, 4),
    ).toBe(0);
    expect(
      effectivePaidSeatCount(
        { billingMode: "self_serve", status: "canceled" },
        4,
      ),
    ).toBe(0);
  });

  test("invoiced (contract) orgs have no Stripe status — seats always count", () => {
    expect(
      effectivePaidSeatCount({ billingMode: "invoiced", status: "none" }, 4),
    ).toBe(4);
  });

  test("orgs predating billing rows fail open", () => {
    expect(effectivePaidSeatCount(null, 4)).toBe(4);
  });
});
