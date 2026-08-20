/**
 * The reconcile that owns the route out of In Review Studio does NOT perform:
 * a PR merged by a person, or by GitHub itself, with `auto_merge` off or never
 * consulted. Storage is a fake — the contract under test is the gate, the
 * status write and the timeline entry, none of which need Postgres.
 */

import { describe, expect, it } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem, TaskBoardItemPrRef } from "@/storage/types";
import { advanceToDoneIfMerged } from "./reconcile-merged";

const PR = {
  url: "https://github.com/acme/repo/pull/1",
  prNumber: 1,
  repoOwner: "acme",
  repoName: "repo",
} as unknown as TaskBoardItemPrRef;

const item = (over: Partial<TaskBoardItem> = {}): TaskBoardItem =>
  ({
    id: "item-1",
    organizationId: "org-1",
    status: "in_review",
    updatedBy: "user-1",
    ...over,
  }) as TaskBoardItem;

function fakeCtx(over: { humanRejectedDone?: boolean } = {}) {
  const updates: { status: string }[] = [];
  const activity: Record<string, unknown>[] = [];
  const ctx = {
    storage: {
      taskBoard: {
        hasHumanRejectedDone: async () => over.humanRejectedDone ?? false,
        update: async (
          _id: string,
          _org: string,
          patch: { status: string },
        ) => {
          updates.push(patch);
          return item({ status: "done" });
        },
        recordActivity: async (entry: Record<string, unknown>) => {
          activity.push(entry);
        },
      },
    },
  } as unknown as StudioContext;
  return { ctx, updates, activity };
}

describe("advanceToDoneIfMerged", () => {
  it("moves a card whose PR landed outside Studio, and says why", async () => {
    const { ctx, updates, activity } = fakeCtx();
    expect(
      await advanceToDoneIfMerged(ctx, item(), [PR], async () => true),
    ).toBe(true);
    expect(updates).toEqual([{ status: "done" }]);
    expect(activity).toEqual([
      {
        taskBoardItemId: "item-1",
        action: "status_changed",
        actorId: null,
        data: { from: "in_review", to: "done", reason: "pr_merged" },
      },
    ]);
  });

  it("leaves an unmerged card alone", async () => {
    const { ctx, updates } = fakeCtx();
    expect(
      await advanceToDoneIfMerged(ctx, item(), [PR], async () => false),
    ).toBe(false);
    expect(updates).toEqual([]);
  });

  // An unreachable GitHub answers null — never read that as shipped.
  it("defers to the next sweep when GitHub does not answer", async () => {
    const { ctx } = fakeCtx();
    expect(
      await advanceToDoneIfMerged(ctx, item(), [PR], async () => null),
    ).toBe(false);
  });

  it("needs every linked PR merged, not just one", async () => {
    const { ctx } = fakeCtx();
    const answers = [true, false];
    expect(
      await advanceToDoneIfMerged(
        ctx,
        item(),
        [PR, PR],
        async () => answers.shift() ?? null,
      ),
    ).toBe(false);
  });

  it("does nothing for a card with no linked PR", async () => {
    const { ctx } = fakeCtx();
    expect(await advanceToDoneIfMerged(ctx, item(), [], async () => true)).toBe(
      false,
    );
  });

  it("only ever moves a card that is still In Review", async () => {
    const { ctx } = fakeCtx();
    expect(
      await advanceToDoneIfMerged(
        ctx,
        item({ status: "in_progress" }),
        [PR],
        async () => true,
      ),
    ).toBe(false);
  });

  // A person who pulled the card back out of Done outranks a merged PR.
  it("honors a human's rejection of Done", async () => {
    const { ctx, updates } = fakeCtx({ humanRejectedDone: true });
    expect(
      await advanceToDoneIfMerged(ctx, item(), [PR], async () => true),
    ).toBe(false);
    expect(updates).toEqual([]);
  });
});
