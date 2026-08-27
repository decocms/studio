import { describe, expect, it } from "bun:test";
import { mintReviewToken, verifyReviewToken } from "./review-token";

const ITEM = "tbi_1";
const CYCLE = new Date("2026-01-01T00:00:00.000Z");

describe("review token", () => {
  it("round-trips the tuple it was minted for", () => {
    const token = mintReviewToken(ITEM, "reviewer", CYCLE);
    expect(token.startsWith("rtok_")).toBe(true);
    expect(verifyReviewToken(token, ITEM, "reviewer", CYCLE)).toBe(true);
  });

  it("rejects another reviewer, task, or cycle", () => {
    const token = mintReviewToken(ITEM, "reviewer", CYCLE);
    expect(verifyReviewToken(token, ITEM, "code_review", CYCLE)).toBe(false);
    expect(verifyReviewToken(token, "tbi_2", "qa", CYCLE)).toBe(false);
    expect(
      verifyReviewToken(token, ITEM, "reviewer", new Date(CYCLE.getTime() + 1)),
    ).toBe(false);
  });

  it("rejects a tampered or empty token", () => {
    const token = mintReviewToken(ITEM, "reviewer", CYCLE);
    expect(verifyReviewToken(`${token}x`, ITEM, "reviewer", CYCLE)).toBe(false);
    expect(
      verifyReviewToken(`rtok_${"A".repeat(43)}`, ITEM, "reviewer", CYCLE),
    ).toBe(false);
    expect(verifyReviewToken("", ITEM, "reviewer", CYCLE)).toBe(false);
  });
});
