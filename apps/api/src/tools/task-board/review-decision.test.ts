/**
 * A reviewToken must verify only within the review cycle it was minted for.
 * Without the cycle check, a token saved from a PRIOR cycle (e.g. a reviewer's
 * own earlier approval) could be replayed after a `request_changes` bounce
 * reopened review, faking a fresh sign-off for a PR the reviewer never
 * actually looked at again.
 */
import { describe, expect, it } from "bun:test";
import { isTokenVerified } from "./review-decision";

const CYCLE_1 = new Date("2026-01-01T10:00:00Z").getTime();
const CYCLE_2 = new Date("2026-01-01T14:00:00Z").getTime();

describe("isTokenVerified", () => {
  it("verifies a claim minted for the current cycle by the matching reviewer", () => {
    expect(
      isTokenVerified({ reviewer: "qa", cycleAt: CYCLE_2 }, "qa", CYCLE_2),
    ).toBe(true);
  });

  it("rejects a claim minted for a PRIOR cycle, even with a matching reviewer", () => {
    expect(
      isTokenVerified({ reviewer: "qa", cycleAt: CYCLE_1 }, "qa", CYCLE_2),
    ).toBe(false);
  });

  it("rejects a claim whose reviewer doesn't match the caller's claimed kind", () => {
    expect(
      isTokenVerified(
        { reviewer: "code_review", cycleAt: CYCLE_2 },
        "qa",
        CYCLE_2,
      ),
    ).toBe(false);
  });

  it("rejects a missing claim (no token, or a token that resolved to nothing)", () => {
    expect(isTokenVerified(null, "qa", CYCLE_2)).toBe(false);
  });
});
