/**
 * Regression coverage for `diffTaskActivityEntries`: the update handler used
 * to log each changed field with its own sequential `await`ed insert. This
 * pure diff is what now gets batched into a single write — these tests pin
 * down exactly which entries a given before/after pair earns, so the batching
 * change can't silently drop or duplicate one.
 */
import { describe, expect, it } from "bun:test";
import type { TaskBoardItem } from "@/storage/types";
import { SUPER_AGENT_ASSIGNEE_ID } from "./schema";
import {
  closesOwnReview,
  delegatesToSuperAgent,
  diffTaskActivityEntries,
  rejectsUngatedDeliveryLane,
  updatesAnyField,
} from "./update";

function item(overrides: Partial<TaskBoardItem> = {}): TaskBoardItem {
  return {
    id: "board_1",
    organizationId: "org_1",
    title: "Title",
    description: null,
    status: "todo",
    priority: "medium",
    type: "chore",
    sprintId: null,
    assigneeId: null,
    assignedBy: null,
    repo: null,
    dueDate: null,
    sortOrder: 0,
    keySeq: 1,
    retryAttempts: 0,
    threads: [],
    tags: [],
    reviewVerdicts: [],
    createdBy: "user_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "user_1",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("diffTaskActivityEntries", () => {
  it("returns nothing when no logged field changed", () => {
    const previous = item();
    expect(diffTaskActivityEntries(previous, item())).toEqual([]);
  });

  it("logs a single changed field", () => {
    const previous = item({ status: "todo" });
    const next = item({ status: "in_progress" });
    expect(diffTaskActivityEntries(previous, next)).toEqual([
      {
        action: "status_changed",
        data: { from: "todo", to: "in_progress" },
      },
    ]);
  });

  it("logs every field that changed in one update, in LOGGED_FIELDS order", () => {
    const previous = item({ status: "todo", priority: "medium" });
    const next = item({ status: "in_progress", priority: "high" });
    expect(diffTaskActivityEntries(previous, next)).toEqual([
      { action: "status_changed", data: { from: "todo", to: "in_progress" } },
      { action: "priority_changed", data: { from: "medium", to: "high" } },
    ]);
  });

  // Type is mandatory, so every change is a move between two types — there is
  // no "set from nothing" or "clear" any more.
  it("logs a type change as a move between two types", () => {
    expect(
      diffTaskActivityEntries(item({ type: "chore" }), item({ type: "bug" })),
    ).toEqual([{ action: "type_changed", data: { from: "chore", to: "bug" } }]);
  });

  it("logs a move off the default like any other", () => {
    expect(
      diffTaskActivityEntries(item({ type: "chore" }), item({ type: "spike" })),
    ).toEqual([
      { action: "type_changed", data: { from: "chore", to: "spike" } },
    ]);
  });

  it("does not log a type that did not move", () => {
    expect(
      diffTaskActivityEntries(item({ type: "chore" }), item({ type: "chore" })),
    ).toEqual([]);
  });

  it("logs a description change without copying its value", () => {
    const previous = item({ description: "old" });
    const next = item({ description: "new" });
    expect(diffTaskActivityEntries(previous, next)).toEqual([
      { action: "description_changed" },
    ]);
  });

  it("logs a tag-set change", () => {
    const previous = item({ tags: [] });
    const next = item({
      tags: [
        {
          id: "tag_1",
          name: "bug",
          color: null,
          createdBy: "user_1",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(diffTaskActivityEntries(previous, next)).toEqual([
      { action: "tags_changed", data: { from: [], to: next.tags } },
    ]);
  });

  it("ignores sortOrder (drag-to-reorder is not logged)", () => {
    const previous = item({ sortOrder: 0 });
    const next = item({ sortOrder: 5 });
    expect(diffTaskActivityEntries(previous, next)).toEqual([]);
  });
});

describe("updatesAnyField", () => {
  // The board's type picker sends this and nothing else; it used to skip the write and still answer 200.
  it("counts a type-only update", () => {
    expect(updatesAnyField({ type: "bug" })).toBe(true);
  });

  it("counts every field that reaches a write, one at a time", () => {
    const oneOf = [
      { title: "t" },
      { description: "d" },
      { status: "todo" },
      { priority: "high" },
      { type: "bug" },
      { assigneeId: "user_1" },
      { repo: "owner/name" },
      { dueDate: "2026-01-01T00:00:00.000Z" },
      { sortOrder: 5 },
      { tagIds: [] },
    ];
    for (const input of oneOf) {
      expect(updatesAnyField(input)).toBe(true);
    }
  });

  it("counts a field explicitly cleared to null", () => {
    expect(updatesAnyField({ assigneeId: null })).toBe(true);
    expect(updatesAnyField({ dueDate: null })).toBe(true);
  });

  it("does not count a link-only update, which must not bump updated_at", () => {
    expect(updatesAnyField({})).toBe(false);
    expect(updatesAnyField({ title: undefined, type: undefined })).toBe(false);
  });
});

describe("delegatesToSuperAgent", () => {
  it("delegates when the assignee changes to the Super Agent", () => {
    expect(
      delegatesToSuperAgent(
        SUPER_AGENT_ASSIGNEE_ID,
        item({ assigneeId: null, status: "todo" }),
      ),
    ).toBe(true);
  });

  it("re-delegates a card parked in To Do already assigned to the Super Agent", () => {
    // A run that failed out of its retry budget returns the card to To Do
    // WITHOUT clearing the assignee. Gating on "the assignee changed" made the
    // Auto fix click a silent no-op and stranded the card in To Do.
    expect(
      delegatesToSuperAgent(
        SUPER_AGENT_ASSIGNEE_ID,
        item({ assigneeId: SUPER_AGENT_ASSIGNEE_ID, status: "todo" }),
      ),
    ).toBe(true);
  });

  it("does not re-delegate a Super Agent card outside To Do", () => {
    for (const status of ["in_progress", "in_review", "done"] as const) {
      expect(
        delegatesToSuperAgent(
          SUPER_AGENT_ASSIGNEE_ID,
          item({ assigneeId: SUPER_AGENT_ASSIGNEE_ID, status }),
        ),
      ).toBe(false);
    }
  });

  it("does not delegate for any other assignee, or when none was passed", () => {
    const previous = item({ assigneeId: null, status: "todo" });
    expect(delegatesToSuperAgent("user_2", previous)).toBe(false);
    expect(delegatesToSuperAgent(null, previous)).toBe(false);
    expect(delegatesToSuperAgent(undefined, previous)).toBe(false);
  });

  it("does not delegate without a pre-update item", () => {
    expect(delegatesToSuperAgent(SUPER_AGENT_ASSIGNEE_ID, null)).toBe(false);
  });
});

describe("closesOwnReview", () => {
  it("catches a run completing a task under review", () => {
    expect(closesOwnReview("done", "in_review", true)).toBe(true);
  });

  it("catches a run archiving a task under review — archiving skips review just like completing", () => {
    expect(closesOwnReview("archived", "in_review", true)).toBe(true);
  });

  // Shipping yourself past review also drops the card out of the review sweep.
  it("catches a run shipping a task under review into a delivery lane", () => {
    expect(closesOwnReview("approved", "in_review", true)).toBe(true);
    expect(closesOwnReview("merged", "in_review", true)).toBe(true);
    expect(closesOwnReview("post_deploy_validation", "in_review", true)).toBe(
      true,
    );
  });

  it("allows a run to complete a task that needed no code change", () => {
    expect(closesOwnReview("done", "in_progress", true)).toBe(false);
  });

  it("allows a run to move a task under review BACKWARD, or not at all", () => {
    expect(closesOwnReview("in_progress", "in_review", true)).toBe(false);
    expect(closesOwnReview(undefined, "in_review", true)).toBe(false);
  });

  it("never catches a person", () => {
    expect(closesOwnReview("done", "in_review", false)).toBe(false);
  });
});

describe("rejectsUngatedDeliveryLane", () => {
  it("refuses a direct write into a delivery lane when the flag is off", () => {
    expect(rejectsUngatedDeliveryLane("approved", false)).toBe(true);
    expect(rejectsUngatedDeliveryLane("merged", false)).toBe(true);
    expect(rejectsUngatedDeliveryLane("post_deploy_validation", false)).toBe(
      true,
    );
  });

  it("allows it once the org runs the delivery lanes", () => {
    expect(rejectsUngatedDeliveryLane("approved", true)).toBe(false);
    expect(rejectsUngatedDeliveryLane("merged", true)).toBe(false);
  });

  it("leaves every other status alone regardless of the flag", () => {
    for (const status of [
      "todo",
      "in_progress",
      "in_review",
      "done",
    ] as const) {
      expect(rejectsUngatedDeliveryLane(status, false)).toBe(false);
    }
    expect(rejectsUngatedDeliveryLane(undefined, false)).toBe(false);
  });
});
