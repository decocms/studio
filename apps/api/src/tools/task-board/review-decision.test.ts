import { describe, expect, it } from "bun:test";
import { reviewTokenVerified } from "./review-decision";

describe("reviewTokenVerified", () => {
  const cycleA = new Date("2026-01-01T00:00:00Z").getTime();
  const cycleB = new Date("2026-01-02T00:00:00Z").getTime();

  it("verifies a claim for the right reviewer on the current cycle", () => {
    const claim = { reviewer: "qa", cycleAt: new Date(cycleA) };
    expect(reviewTokenVerified(claim, "qa", cycleA)).toBe(true);
  });

  it("rejects a claim whose reviewer doesn't match", () => {
    const claim = { reviewer: "qa", cycleAt: new Date(cycleA) };
    expect(reviewTokenVerified(claim, "code_review", cycleA)).toBe(false);
  });

  it("rejects a stale token from an earlier review cycle", () => {
    const claim = { reviewer: "qa", cycleAt: new Date(cycleA) };
    expect(reviewTokenVerified(claim, "qa", cycleB)).toBe(false);
  });

  it("rejects a missing claim", () => {
    expect(reviewTokenVerified(null, "qa", cycleA)).toBe(false);
  });
});
