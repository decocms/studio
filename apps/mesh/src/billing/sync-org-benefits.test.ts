import { describe, expect, test } from "bun:test";
import { computeAllowanceMicros } from "./sync-org-benefits";

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
