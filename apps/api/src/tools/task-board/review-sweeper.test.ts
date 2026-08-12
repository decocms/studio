/**
 * The two terminals the review sweeper owns, kept as pure predicates so they're
 * unit-testable without a running sweep. The reviewer hand-off gate itself
 * (`prReadyForReview`) lives in `pr-ready-for-review.test.ts` — reviewers now
 * dispatch without waiting on CI, so check status is not part of this contract.
 */

import { describe, expect, it } from "bun:test";
import { TaskQuotaError } from "@/billing/task-quota";
import { isPermanentDispatchFailure, noPrHandoffDue } from "./review-sweeper";

/**
 * The retry re-arm keeps `attempts` untouched, on purpose: a dispatch that
 * failed on infrastructure deserves the same recovery as the run it was going
 * to start. That makes the classification load-bearing — a failure that can
 * never clear would be re-armed forever, which is what a quota rejection did.
 */
describe("isPermanentDispatchFailure", () => {
  it("a quota rejection can never clear on a later tick", () => {
    for (const reason of ["runs_exhausted", "trial_exhausted"] as const) {
      expect(isPermanentDispatchFailure(new TaskQuotaError(reason))).toBe(true);
    }
  });

  it("anything else is a blip worth re-arming for", () => {
    expect(isPermanentDispatchFailure(new Error("connection reset"))).toBe(
      false,
    );
    expect(isPermanentDispatchFailure("no model configured")).toBe(false);
    expect(isPermanentDispatchFailure(undefined)).toBe(false);
  });
});

/**
 * The other terminal the sweeper owns: a card parked In Review with no PR. No
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
