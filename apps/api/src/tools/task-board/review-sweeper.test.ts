/**
 * The check gate the sweeper and the task dialog SHARE. It has to be one
 * predicate: a reviewer claim is spent once per review cycle and nothing
 * re-dispatches inside a cycle, so if the sweeper's 60s tick dispatched on a PR
 * whose CI was still running (which it always would — CI takes minutes) it would
 * consume the cycle and the green-CI review would never happen.
 */

import { describe, expect, it } from "bun:test";
import { prReadyForReview } from "./prs-get";

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

  // `state: null` is what a GitHub fetch failure looks like (NO_LIVE_STATE) —
  // that must read as "don't dispatch", not "no checks, go ahead".
  it("is not ready when the live state could not be fetched", () => {
    expect(prReadyForReview([pr({ state: null, checksStatus: null })])).toBe(
      false,
    );
  });
});
