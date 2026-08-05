/**
 * The reviewer hand-off gate, and specifically what it does when it does NOT
 * know the PR's state.
 *
 * This froze the review pipeline in prod. `fetchPrLiveState` is best-effort and
 * returns EVERY field as `null` when the GitHub call fails, so the previous
 * `state === "open"` form answered "not ready" for every card the moment GitHub
 * went quiet — and the sweeper rejected its whole batch through a plain `return
 * false` that logged nothing. 45 cards sat In Review with dispatching stopped
 * dead and no error anywhere.
 *
 * So the rule under test is: only a DEFINITE reason blocks. Unknown means "we
 * could not ask", not "no".
 */
import { describe, expect, test } from "bun:test";
import { prReadyForReview } from "./prs-get";

type Pr = Parameters<typeof prReadyForReview>[0][number];

const pr = (o: Partial<Pr> = {}): Pr => ({
  state: "open",
  merged: false,
  checksStatus: null,
  ...o,
});

describe("prReadyForReview", () => {
  test("an open PR with no CI is ready — a card without a pipeline must not sit forever", () => {
    expect(prReadyForReview([pr({ checksStatus: null })])).toBe(true);
  });

  test("an open PR with passing checks is ready", () => {
    expect(prReadyForReview([pr({ checksStatus: "passing" })])).toBe(true);
  });

  // The regression. All-null is what a failed GitHub read looks like.
  test("unknown state does NOT block — this is the prod freeze", () => {
    expect(
      prReadyForReview([{ state: null, merged: null, checksStatus: null }]),
    ).toBe(true);
  });

  test("unknown state with a known-pending check still blocks", () => {
    expect(
      prReadyForReview([
        { state: null, merged: null, checksStatus: "pending" },
      ]),
    ).toBe(false);
  });

  test("a definitely closed PR blocks", () => {
    expect(prReadyForReview([pr({ state: "closed" })])).toBe(false);
  });

  test("a definitely merged PR blocks", () => {
    expect(prReadyForReview([pr({ merged: true })])).toBe(false);
  });

  test("pending checks block — the sweeper's 60s tick must not beat CI", () => {
    expect(prReadyForReview([pr({ checksStatus: "pending" })])).toBe(false);
  });

  test("failing checks block", () => {
    expect(prReadyForReview([pr({ checksStatus: "failing" })])).toBe(false);
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
