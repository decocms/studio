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
import { mayBeConflict } from "./merge-pr";

const BOTH = ["qa", "code_review"] as const;
const at = "2026-08-12T00:00:00.000Z";
const approved = (
  reviewer: string,
  verified: boolean,
): ReviewCycleActivity => ({
  action: "review_approved",
  data: { reviewer, verified },
  occurredAt: at,
});

describe("mayBeConflict", () => {
  it("is true for a plain refusal — the one outcome a conflict looks like", () => {
    expect(mayBeConflict({ merged: false, reason: "refused" })).toBe(true);
    expect(
      mayBeConflict({
        merged: false,
        reason: "refused",
        detail: "405 Pull Request has merge conflicts",
      }),
    ).toBe(true);
  });

  // A 429 says nothing about mergeability, and re-asking IS the burst.
  it("is false for a rate limit however it is detailed", () => {
    expect(
      mayBeConflict({
        merged: false,
        reason: "rate_limited",
        detail: "Streamable HTTP error: too many requests",
      }),
    ).toBe(false);
    expect(mayBeConflict({ merged: false, reason: "rate_limited" })).toBe(
      false,
    );
  });

  it("is false for every non-refusal outcome", () => {
    expect(mayBeConflict({ merged: true })).toBe(false);
    for (const reason of [
      "no_pr",
      "checks_pending",
      "checks_failing",
      "no_connection",
      "rate_limited",
      "error",
    ] as const) {
      expect(mayBeConflict({ merged: false, reason })).toBe(false);
    }
  });
});

describe("approvedButUnverified", () => {
  it("is true when a full set of approvals includes an unverified one", () => {
    const activity = [approved("qa", true), approved("code_review", false)];
    expect(approvedButUnverified(activity, [...BOTH])).toBe(true);
  });

  // The happy path must not be handed to a human — it is about to merge.
  it("is false when every approval verified", () => {
    const activity = [approved("qa", true), approved("code_review", true)];
    expect(approvedButUnverified(activity, [...BOTH])).toBe(false);
  });

  // Still waiting on the other reviewer is not a dead end.
  it("is false while a reviewer has not voted yet", () => {
    expect(approvedButUnverified([approved("qa", false)], [...BOTH])).toBe(
      false,
    );
  });

  it("is false when a reviewer requested changes", () => {
    const activity: ReviewCycleActivity[] = [
      approved("qa", false),
      {
        action: "review_changes_requested",
        data: { reviewer: "code_review", verified: true },
        occurredAt: at,
      },
    ];
    expect(approvedButUnverified(activity, [...BOTH])).toBe(false);
  });
});
