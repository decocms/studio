/**
 * The two decisions a failed auto-merge has to get right. Both were silent
 * `return false`s, and both stranded real cards In Review: an approved PR that
 * had drifted into a conflict was retried every five minutes forever with
 * nobody dispatched to rebase it, and a full set of approvals that didn't
 * verify sat there for a week looking ready to ship. Pure; the merge round-trip
 * itself is e2e.
 */
import { describe, expect, it } from "bun:test";
import type { ReviewCycleActivity } from "@decocms/shared/task-board";
import { approvedButUnverified } from "@decocms/shared/task-board";
import { checksBlockMerge, conflictFromOutcome, reasonFor } from "./merge-pr";

const ENABLED = ["reviewer"] as const;
const at = "2026-08-12T00:00:00.000Z";
const approved = (
  reviewer: string,
  verified: boolean,
): ReviewCycleActivity => ({
  action: "review_approved",
  data: { reviewer, verified },
  occurredAt: at,
});

describe("reasonFor", () => {
  /** The one refusal with an automatic answer: the agent can rebase. */
  it("keeps a conflict distinguishable from every other refusal", () => {
    expect(reasonFor({ merged: false, reason: "conflict", detail: "" })).toBe(
      "conflict",
    );
    expect(reasonFor({ merged: false, reason: "blocked", detail: "" })).toBe(
      "refused",
    );
  });

  /** A 429 says nothing about mergeability, and re-asking IS the burst. */
  it("reports a rate limit as its own reason, never as a refusal", () => {
    expect(
      reasonFor({ merged: false, reason: "rate_limited", detail: "" }),
    ).toBe("rate_limited");
  });

  it("reads 'it is not there' as the card's no-PR case", () => {
    expect(reasonFor({ merged: false, reason: "not_found", detail: "" })).toBe(
      "no_pr",
    );
  });

  it("falls back to error for a transport failure", () => {
    expect(reasonFor({ merged: false, reason: "error", detail: "boom" })).toBe(
      "error",
    );
  });
});

describe("conflictFromOutcome", () => {
  it("is true only for a classified conflict", () => {
    expect(conflictFromOutcome({ merged: false, reason: "conflict" })).toBe(
      true,
    );
  });

  /**
   * Never false: a policy refusal is not evidence the branch is clean, and the
   * conflict reaction may only act on an explicit true.
   */
  it("is null for every other outcome, never false", () => {
    for (const reason of [
      "no_pr",
      "checks_pending",
      "checks_failing",
      "no_connection",
      "rate_limited",
      "refused",
      "error",
    ] as const) {
      expect(conflictFromOutcome({ merged: false, reason })).toBeNull();
    }
    expect(conflictFromOutcome({ merged: true })).toBeNull();
    expect(conflictFromOutcome(null)).toBeNull();
  });
});

describe("checksBlockMerge", () => {
  it("blocks red CI for every caller, override or not", () => {
    expect(checksBlockMerge("failing")).toBe(true);
    expect(checksBlockMerge("failing", { allowPendingChecks: true })).toBe(
      true,
    );
  });

  it("blocks pending CI by default (the automatic paths must wait)", () => {
    expect(checksBlockMerge("pending")).toBe(true);
  });

  it("lets a human ship over pending CI with allowPendingChecks", () => {
    expect(checksBlockMerge("pending", { allowPendingChecks: true })).toBe(
      false,
    );
  });

  it("never blocks on passing or unknown checks", () => {
    expect(checksBlockMerge("passing")).toBe(false);
    expect(checksBlockMerge(null)).toBe(false);
    expect(checksBlockMerge(null, { allowPendingChecks: true })).toBe(false);
  });
});

describe("approvedButUnverified", () => {
  it("is true when the approval is unverified — green checks that can never merge", () => {
    expect(
      approvedButUnverified([approved("reviewer", false)], [...ENABLED], {
        cycleStartedAt: null,
      }),
    ).toBe(true);
  });

  // The happy path must not be handed to a human — it is about to merge.
  it("is false when the approval verified", () => {
    expect(
      approvedButUnverified([approved("reviewer", true)], [...ENABLED], {
        cycleStartedAt: null,
      }),
    ).toBe(false);
  });

  // Not yet voted is not a dead end.
  it("is false while the reviewer has not voted yet", () => {
    expect(
      approvedButUnverified([], [...ENABLED], { cycleStartedAt: null }),
    ).toBe(false);
  });

  it("is false when the reviewer requested changes", () => {
    const activity: ReviewCycleActivity[] = [
      {
        action: "review_changes_requested",
        data: { reviewer: "reviewer", verified: true },
        occurredAt: at,
      },
    ];
    expect(
      approvedButUnverified(activity, [...ENABLED], { cycleStartedAt: null }),
    ).toBe(false);
  });
});
