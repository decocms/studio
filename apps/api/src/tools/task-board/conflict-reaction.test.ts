/**
 * Pure logic behind conflict auto-resolution: the per-task dispatch cap. The
 * orchestration (claim fence, enqueue, gating against real storage) is
 * integration/e2e; this pins only the bound, where an off-by-one would let a
 * conflict the agent can't resolve loop forever.
 */
import { describe, expect, it } from "bun:test";
import type { ReviewCycleActivity } from "@decocms/shared/task-board";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import {
  conflictResolutionCapReached,
  isConflictResolutionCandidate,
} from "./conflict-reaction";

const at = "2026-08-03T00:00:00.000Z";
const resolution = (): ReviewCycleActivity => ({
  action: "merge_conflict_resolution",
  occurredAt: at,
});
const other = (): ReviewCycleActivity => ({
  action: "review_approved",
  occurredAt: at,
});

describe("conflictResolutionCapReached", () => {
  it("is false below the cap (0, 1, 2 prior resolutions)", () => {
    expect(conflictResolutionCapReached([])).toBe(false);
    expect(conflictResolutionCapReached([resolution()])).toBe(false);
    expect(conflictResolutionCapReached([resolution(), resolution()])).toBe(
      false,
    );
  });

  it("is true at exactly the cap of 3 (the off-by-one boundary)", () => {
    expect(
      conflictResolutionCapReached([resolution(), resolution(), resolution()]),
    ).toBe(true);
  });

  it("stays true beyond the cap", () => {
    expect(
      conflictResolutionCapReached([
        resolution(),
        resolution(),
        resolution(),
        resolution(),
      ]),
    ).toBe(true);
  });

  it("counts only merge_conflict_resolution entries, ignoring other actions", () => {
    expect(
      conflictResolutionCapReached([
        other(),
        resolution(),
        other(),
        resolution(),
        other(),
      ]),
    ).toBe(false);
  });
});

describe("isConflictResolutionCandidate", () => {
  const item = { status: "in_review", assigneeId: SUPER_AGENT_ASSIGNEE_ID };

  it("is true for an In Review Super Agent task with a detected conflict", () => {
    expect(isConflictResolutionCandidate(item, true)).toBe(true);
  });

  it("is false for a human-owned task", () => {
    expect(
      isConflictResolutionCandidate(
        { status: "in_review", assigneeId: "user-1" },
        true,
      ),
    ).toBe(false);
  });

  it("is false without a confirmed conflict", () => {
    expect(isConflictResolutionCandidate(item, null)).toBe(false);
    expect(isConflictResolutionCandidate(item, false)).toBe(false);
  });

  it("is false once the task moved on", () => {
    expect(
      isConflictResolutionCandidate(
        { status: "in_progress", assigneeId: SUPER_AGENT_ASSIGNEE_ID },
        true,
      ),
    ).toBe(false);
  });
});
