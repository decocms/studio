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
import { isPermanentDispatchFailure } from "./review-sweeper";

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
