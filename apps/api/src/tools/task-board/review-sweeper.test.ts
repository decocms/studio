/**
 * A terminal the review sweeper owns, kept as a pure predicate so it's
 * unit-testable without a running sweep. The reviewer hand-off gate itself
 * (`prReadyForReview`) lives in `pr-ready-for-review.test.ts` — reviewers now
 * dispatch without waiting on CI, so check status is not part of this contract.
 */

import { describe, expect, it } from "bun:test";
import { noPrHandoffDue } from "./review-sweeper";

/**
 * A card parked In Review with no PR. No
 * reviewer is ever dispatched at it, so without a handover it is swept forever
 * and reads like a card whose reviewers are still thinking.
 */
describe("noPrHandoffDue", () => {
  const CYCLE = new Date("2026-01-01T10:00:00Z").getTime();
  const at = (mins: number) => CYCLE + mins * 60_000;

  it("waits out the grace — the PR link and the status move are two calls", () => {
    expect(noPrHandoffDue(CYCLE, at(1))).toBe(false);
    expect(noPrHandoffDue(CYCLE, at(14))).toBe(false);
  });

  it("hands over once the card has sat there past the grace", () => {
    expect(noPrHandoffDue(CYCLE, at(15))).toBe(true);
    expect(noPrHandoffDue(CYCLE, at(60 * 24))).toBe(true);
  });

  // A card with no recorded review cycle reads as infinitely old — hand it over.
  it("hands over a card with no recorded review cycle at all", () => {
    expect(noPrHandoffDue(0, at(0))).toBe(true);
  });
});
