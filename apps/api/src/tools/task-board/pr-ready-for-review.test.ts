/**
 * The reviewer hand-off gate: is there a PR worth dispatching a reviewer at?
 *
 * Two rules under test:
 * 1. Only a DEFINITE reason blocks — a PR we know is closed or merged. Unknown
 *    (all-null, a failed GitHub read) means "we could not ask", not "no"; the
 *    old `state === "open"` form froze 45 cards In Review the moment GitHub went
 *    quiet.
 * 2. Check status does NOT gate — reviewers run without waiting for CI (the
 *    merge is gated on green separately). `prReadyForReview` no longer even
 *    receives `checksStatus`, so a pending/failing PR is still reviewable.
 */
import { describe, expect, test } from "bun:test";
import { prReadyForReview } from "./prs-get";

type Pr = Parameters<typeof prReadyForReview>[0][number];

const pr = (o: Partial<Pr> = {}): Pr => ({
  state: "open",
  merged: false,
  ...o,
});

describe("prReadyForReview", () => {
  test("an open PR is ready — regardless of CI", () => {
    expect(prReadyForReview([pr()])).toBe(true);
  });

  // The regression. All-null is what a failed GitHub read looks like.
  test("unknown state does NOT block — this is the prod freeze", () => {
    expect(prReadyForReview([{ state: null, merged: null }])).toBe(true);
  });

  test("a definitely closed PR blocks", () => {
    expect(prReadyForReview([pr({ state: "closed" })])).toBe(false);
  });

  test("a definitely merged PR blocks", () => {
    expect(prReadyForReview([pr({ merged: true })])).toBe(false);
  });

  test("no PRs at all is not ready", () => {
    expect(prReadyForReview([])).toBe(false);
  });

  // A task can accumulate several PRs across re-runs; one live candidate is
  // enough, and a closed earlier attempt must not veto it.
  test("a closed old PR alongside an open one is ready", () => {
    expect(
      prReadyForReview([pr({ state: "closed" }), pr({ state: "open" })]),
    ).toBe(true);
  });

  test("every PR merged or closed is not ready", () => {
    expect(
      prReadyForReview([pr({ merged: true }), pr({ state: "closed" })]),
    ).toBe(false);
  });
});
