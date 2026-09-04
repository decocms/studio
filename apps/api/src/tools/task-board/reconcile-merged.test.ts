/**
 * The reconcile that owns the route out of In Review Studio does NOT perform:
 * a PR merged by a person, or by GitHub itself, with `auto_merge` off or never
 * consulted. Storage is a fake — the contract under test is the gate, the
 * status write and the timeline entry, none of which need Postgres.
 *
 * The live PR states arrive from the sweeper's own throttled PR read, so there
 * is no GitHub reader to stub here (see `advanceToDoneIfMerged`'s doc comment).
 */

import { describe, expect, it } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import type { PrLanding } from "./archive-merged";
import { advanceToDoneIfMerged } from "./reconcile-merged";

const REPO = { repoOwner: "acme", repoName: "storefront" };
const merged: PrLanding = { ...REPO, state: "closed", merged: true };
const openPr: PrLanding = { ...REPO, state: "open", merged: false };
const abandoned: PrLanding = { ...REPO, state: "closed", merged: false };
const unreadable: PrLanding = { ...REPO, state: null, merged: null };
const otherRepoOpen: PrLanding = {
  repoOwner: "acme",
  repoName: "storefront-us",
  state: "open",
  merged: false,
};

const item = (over: Partial<TaskBoardItem> = {}): TaskBoardItem =>
  ({
    id: "item-1",
    organizationId: "org-1",
    virtualMcpId: null,
    status: "in_review",
    reviewCycleStartedAt: null,
    updatedBy: "user-1",
    ...over,
  }) as TaskBoardItem;

function fakeCtx(
  over: { humanRejectedDone?: boolean; deliveryLanes?: boolean } = {},
) {
  const updates: { status: string }[] = [];
  const activity: Record<string, unknown>[] = [];
  const ctx = {
    storage: {
      organizationSettings: {
        get: async () => ({
          flags: {
            delivery_lanes_enabled: over.deliveryLanes ?? false,
          },
        }),
      },
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
  it("moves a card whose PR landed outside Studio to Done, and says why", async () => {
    const { ctx, updates, activity } = fakeCtx();
    expect(await advanceToDoneIfMerged(ctx, item(), [merged])).toBe(true);
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

  // With the lanes on a merged PR is DEPLOYED, not finished.
  it("lands on Merged when the org runs the delivery lanes", async () => {
    const { ctx, updates, activity } = fakeCtx({ deliveryLanes: true });
    expect(await advanceToDoneIfMerged(ctx, item(), [merged])).toBe(true);
    expect(updates).toEqual([{ status: "merged" }]);
    expect(activity[0]).toMatchObject({
      data: { from: "in_review", to: "merged", reason: "pr_merged" },
    });
  });

  // The org-owned board needs the same discriminator a manual move sets (#6725).

  it("leaves an unmerged card alone", async () => {
    const { ctx, updates } = fakeCtx();
    expect(await advanceToDoneIfMerged(ctx, item(), [openPr])).toBe(false);
    expect(updates).toEqual([]);
  });

  // A read that could not reach GitHub answers null — never read that as
  // shipped. This is also what an unregistered/timed-out throttled read yields.
  it("defers to the next sweep when GitHub does not answer", async () => {
    const { ctx } = fakeCtx();
    expect(await advanceToDoneIfMerged(ctx, item(), [unreadable])).toBe(false);
  });

  it("needs every repo the card touches to have landed", async () => {
    const { ctx } = fakeCtx();
    expect(
      await advanceToDoneIfMerged(ctx, item(), [merged, otherRepoOpen]),
    ).toBe(false);
  });

  // Inverts the old every-PR rule, which stranded a bounced card in review.
  it("moves past a PR the bounce abandoned in the same repo", async () => {
    const { ctx, updates } = fakeCtx();
    expect(await advanceToDoneIfMerged(ctx, item(), [abandoned, merged])).toBe(
      true,
    );
    expect(updates).toEqual([{ status: "done" }]);
  });

  it("does nothing for a card with no linked PR", async () => {
    const { ctx } = fakeCtx();
    expect(await advanceToDoneIfMerged(ctx, item(), [])).toBe(false);
  });

  it("only ever moves a card that is still in the review phase", async () => {
    const { ctx } = fakeCtx();
    expect(
      await advanceToDoneIfMerged(ctx, item({ status: "in_progress" }), [
        merged,
      ]),
    ).toBe(false);
  });

  // A card whose reviewer is still working reads In Progress since migration
  // 189, and a PR merged out from under it must still catch the card up —
  // gating on the lane alone would leave it behind forever.
  it("moves an In Progress card whose review cycle is open", async () => {
    const { ctx, updates } = fakeCtx();
    expect(
      await advanceToDoneIfMerged(
        ctx,
        item({
          status: "in_progress",
          reviewCycleStartedAt: "2026-01-01T00:00:00.000Z",
        }),
        [merged],
      ),
    ).toBe(true);
    expect(updates).toEqual([{ status: "done" }]);
  });

  // A person who pulled the card back out of Done outranks a merged PR.
  it("honors a human's rejection of Done", async () => {
    const { ctx, updates } = fakeCtx({ humanRejectedDone: true });
    expect(await advanceToDoneIfMerged(ctx, item(), [merged])).toBe(false);
    expect(updates).toEqual([]);
  });
});
