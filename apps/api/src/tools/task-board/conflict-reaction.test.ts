/**
 * Pure logic behind conflict auto-resolution: the per-task dispatch cap. The
 * orchestration (claim fence, enqueue, gating against real storage) is
 * integration/e2e; this pins only the bound, where an off-by-one would let a
 * conflict the agent can't resolve loop forever.
 */
import { describe, expect, it } from "bun:test";
import type { ReviewCycleActivity } from "@decocms/shared/task-board";
import { conflictResolutionCapReached } from "./conflict-reaction";

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
