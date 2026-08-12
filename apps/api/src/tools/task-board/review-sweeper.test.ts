/**
 * The check gate the sweeper and the task dialog SHARE. It has to be one
 * predicate: a reviewer claim is spent once per review cycle and nothing
 * re-dispatches inside a cycle, so if the sweeper's 60s tick dispatched on a PR
 * whose CI was still running (which it always would — CI takes minutes) it would
 * consume the cycle and the green-CI review would never happen.
 */

import { describe, expect, it } from "bun:test";
import { TaskQuotaError } from "@/billing/task-quota";
import { prReadyForReview } from "./prs-get";
import { isPermanentDispatchFailure, noPrHandoffDue } from "./review-sweeper";

const pr = (over: Partial<Parameters<typeof prReadyForReview>[0][number]>) => ({
  state: "open",
  merged: false,
  checksStatus: "passing",
  ...over,
});

describe("prReadyForReview", () => {
  it("is ready when the open PR's checks pass", () => {
    expect(prReadyForReview([pr({})])).toBe(true);
  });

  // A PR with no pipeline at all must not sit In Review forever.
  it("is ready when the PR has no checks", () => {
    expect(prReadyForReview([pr({ checksStatus: null })])).toBe(true);
  });

  it("waits while checks are pending", () => {
    expect(prReadyForReview([pr({ checksStatus: "pending" })])).toBe(false);
  });

  it("waits while checks are failing", () => {
    expect(prReadyForReview([pr({ checksStatus: "failing" })])).toBe(false);
  });

  it("is not ready with no PR at all", () => {
    expect(prReadyForReview([])).toBe(false);
  });

  it("is not ready when the only PR is merged or closed", () => {
    expect(prReadyForReview([pr({ merged: true })])).toBe(false);
    expect(prReadyForReview([pr({ state: "closed" })])).toBe(false);
  });

  // A card can carry more than one PR (a re-run opens a second one); the open
  // one decides.
  it("judges the open PR when a merged one is also linked", () => {
    expect(
      prReadyForReview([
        pr({ merged: true, checksStatus: "failing" }),
        pr({ checksStatus: "passing" }),
      ]),
    ).toBe(true);
  });

  // INVERTED. This used to assert that an unfetchable live state reads as
  // "don't dispatch". It shipped, and it froze the review pipeline: every field
  // of `NO_LIVE_STATE` is null, so the moment GitHub stopped answering, this
  // returned false for EVERY card and the sweeper rejected its whole batch
  // through a `return false` that logs nothing — 45 cards parked In Review with
  // no error anywhere. Unknown means "we could not ask", not "no"; only a
  // definite closed/merged/pending/failing blocks. See
  // `pr-ready-for-review.test.ts` for the full truth table.
  it("is ready when the live state could not be fetched — unknown must not block", () => {
    expect(prReadyForReview([pr({ state: null, checksStatus: null })])).toBe(
      true,
    );
  });
});

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

  // No `→ in_review` entry on the timeline reads as infinitely old, which is
  // right: those are the oldest strands and no PR is coming for them either.
  it("hands over a card with no recorded review cycle at all", () => {
    expect(noPrHandoffDue(0, at(0))).toBe(true);
  });
});
