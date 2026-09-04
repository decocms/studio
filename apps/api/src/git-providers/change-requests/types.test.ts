/**
 * The one reducer both providers share: a run list to a single CI summary.
 *
 * It lives in the interface rather than in either implementation precisely so
 * these cases hold for both — a red build must not mean different things on
 * GitHub and GitLab.
 */
import { describe, expect, it } from "bun:test";
import type { CheckRun } from "./types";
import { summarizeChecks } from "./types";

const run = (over: Partial<CheckRun> = {}): CheckRun => ({
  id: "1",
  name: "build",
  state: "completed",
  conclusion: "success",
  url: null,
  durationMs: null,
  summary: null,
  ...over,
});

describe("summarizeChecks", () => {
  /** A change request without CI is not "pending" — it has nothing to say. */
  it("is null for no runs at all", () => {
    expect(summarizeChecks([])).toBeNull();
  });

  it("is passing when every run finished well", () => {
    expect(
      summarizeChecks([
        run(),
        run({ conclusion: "neutral" }),
        run({ conclusion: "skipped" }),
      ]),
    ).toBe("passing");
  });

  it("is pending while any run is unfinished", () => {
    expect(
      summarizeChecks([run(), run({ state: "queued", conclusion: null })]),
    ).toBe("pending");
    expect(summarizeChecks([run({ state: "running", conclusion: null })])).toBe(
      "pending",
    );
  });

  /** Failing wins over pending: the worst answer is the actionable one. */
  it("is failing as soon as one run failed, even mid-pipeline", () => {
    expect(
      summarizeChecks([
        run({ state: "running", conclusion: null }),
        run({ conclusion: "failure" }),
      ]),
    ).toBe("failing");
  });

  /**
   * A run that did not finish is not evidence the head is good, so a
   * cancellation and a timeout are red — the same reading GitLab's `canceled`
   * pipeline gets.
   */
  it("treats a cancelled, timed-out or action-required run as red", () => {
    for (const conclusion of [
      "cancelled",
      "timed_out",
      "action_required",
    ] as const) {
      expect(summarizeChecks([run({ conclusion })])).toBe("failing");
    }
  });
});
