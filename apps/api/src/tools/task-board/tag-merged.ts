/**
 * Auto-tag: a Done card whose linked PRs have all landed gets the org's
 * `merged` tag, so "done" and "actually shipped" are told apart on the board
 * without opening every card's PR link.
 *
 * Same shape and the same gate as `archive-merged.ts` (it reuses `allPrsMerged`
 * and `groupByOrg`), but no settle window: the tag is a statement about the PR,
 * not about the card being finished with. It runs unattended on the hourly
 * `taskBoardMergedTagSweepWorkflow` (see `dbos-tag-merged-sweep.ts`) — nothing
 * about it is a decision a human makes per task.
 *
 * Additive only (`addItemTags`): the sweep owns this one label and never
 * touches the ones a human put on the card. It also never removes it — a card
 * whose PR is somehow un-merged keeps the tag until someone takes it off by
 * hand, which is the conservative direction for a label nobody gates on.
 */

import { nextTagColor } from "@decocms/shared/task-board";
import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItemPrRef } from "@/storage/types";
import { recordTaskActivity } from "./activity";
import { allPrsMerged } from "./archive-merged";
import { fetchPrMerged } from "./prs-get";
import { emitTaskBoardUpdated } from "./run-reactions";

/** Lowercase — org tags are matched case-insensitively, so an existing
 *  "Merged" is reused rather than forked into a second tag. */
export const MERGED_TAG_NAME = "merged";

/** How the sweep asks GitHub whether a PR merged — a parameter only so a
 *  local/CI harness can drive the tag path without a GitHub connection. */
type PrMergedReader = (
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
) => Promise<boolean | null>;

/**
 * The org's `merged` tag id, created on first use. Resolved lazily — only once
 * a card actually qualifies — so a sweep over an org with nothing merged does
 * not leave an unused tag in its tag picker.
 */
async function resolveMergedTagId(
  ctx: StudioContext,
  organizationId: string,
): Promise<string> {
  const existing = await ctx.storage.tags.listOrgTags(organizationId);
  const found = existing.find(
    (tag) => tag.name.toLowerCase() === MERGED_TAG_NAME,
  );
  if (found) return found.id;
  const created = await ctx.storage.tags.createTag(
    organizationId,
    MERGED_TAG_NAME,
    nextTagColor(existing.length),
  );
  return created.id;
}

/**
 * Tag one candidate if its PRs are all merged. Returns whether it was tagged.
 *
 * Re-reads the card inside the org's context and re-checks `status === "done"`:
 * the sweep's work list is a snapshot, and a card someone dragged out of Done
 * in the meantime must not be tagged. `null` (GitHub unreachable) is never read
 * as merged, so a bad fetch defers to the next sweep instead of tagging on a
 * guess.
 */
async function tagIfMerged(
  ctx: StudioContext,
  organizationId: string,
  itemId: string,
  tagId: () => Promise<string>,
  prMerged: PrMergedReader,
): Promise<boolean> {
  const item = await ctx.storage.taskBoard.getById(itemId, organizationId);
  if (!item || item.status !== "done") return false;

  const prs = await ctx.storage.taskBoard.listPrs(itemId, organizationId);
  const merged = await Promise.all(
    prs.map((pr) => prMerged(ctx, organizationId, pr)),
  );
  if (!allPrsMerged(merged)) return false;

  await ctx.storage.taskBoard.addItemTags(itemId, [await tagId()], "system");
  const updated = await ctx.storage.taskBoard.getById(itemId, organizationId);
  if (!updated) return false;

  await recordTaskActivity(ctx, {
    taskBoardItemId: itemId,
    action: "tags_changed",
    actorId: null,
    data: { from: item.tags, to: updated.tags, reason: "merged_pr_auto_tag" },
  });
  emitTaskBoardUpdated(organizationId, updated);
  return true;
}

/**
 * One org's leg of the sweep — its own candidates only, folded to a count so a
 * single unreachable GitHub connection can't fail the whole tick.
 *
 * Card-at-a-time within the org: GitHub's secondary rate limit punishes bursts,
 * and the orgs themselves already run in parallel.
 */
export async function tagMergedForOrg(
  ctx: StudioContext,
  organizationId: string,
  itemIds: string[],
  prMerged: PrMergedReader = fetchPrMerged,
): Promise<{ tagged: number }> {
  let cached: Promise<string> | null = null;
  const tagId = () => (cached ??= resolveMergedTagId(ctx, organizationId));

  let tagged = 0;
  for (const itemId of itemIds) {
    try {
      if (await tagIfMerged(ctx, organizationId, itemId, tagId, prMerged)) {
        tagged += 1;
      }
    } catch (err) {
      console.error(`[task-board-merged-tag] ${itemId} failed`, err);
    }
  }
  return { tagged };
}
