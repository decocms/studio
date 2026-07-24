import { describe, expect, test } from "bun:test";
import {
  computeAllowanceMicros,
  effectivePaidSeatCount,
  planReportScheduleSync,
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

describe("planReportScheduleSync", () => {
  test("first choice arms it (nothing to disarm)", () => {
    expect(
      planReportScheduleSync({
        paidSeatCount: 2,
        includedReportUrl: "a.example.com",
        armedReportUrl: null,
      }),
    ).toEqual({ desired: "a.example.com", disarm: null, arm: "a.example.com" });
  });

  test("choice change disarms the old site before arming the new", () => {
    expect(
      planReportScheduleSync({
        paidSeatCount: 2,
        includedReportUrl: "b.example.com",
        armedReportUrl: "a.example.com",
      }),
    ).toEqual({
      desired: "b.example.com",
      disarm: "a.example.com",
      arm: "b.example.com",
    });
  });

  test("clearing the choice disarms without re-arming", () => {
    expect(
      planReportScheduleSync({
        paidSeatCount: 2,
        includedReportUrl: null,
        armedReportUrl: "a.example.com",
      }),
    ).toEqual({ desired: null, disarm: "a.example.com", arm: null });
  });

  test("converged state is a no-op", () => {
    expect(
      planReportScheduleSync({
        paidSeatCount: 2,
        includedReportUrl: "a.example.com",
        armedReportUrl: "a.example.com",
      }),
    ).toEqual({ desired: "a.example.com", disarm: null, arm: null });
  });

  test("zero effective seats disarms even with a choice stored", () => {
    expect(
      planReportScheduleSync({
        paidSeatCount: 0,
        includedReportUrl: "a.example.com",
        armedReportUrl: "a.example.com",
      }),
    ).toEqual({ desired: null, disarm: "a.example.com", arm: null });
  });

  test("zero seats and nothing armed is a no-op", () => {
    expect(
      planReportScheduleSync({
        paidSeatCount: 0,
        includedReportUrl: "a.example.com",
        armedReportUrl: null,
      }),
    ).toEqual({ desired: null, disarm: null, arm: null });
  });
});
