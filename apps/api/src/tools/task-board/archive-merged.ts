/**
 * Auto-archive: a Done card whose PRs landed and which nobody has touched for a
 * day is history, and history belongs in the Archived lane rather than in a Done
 * column with 77 cards nobody reads.
 *
 * Deliberately NOT an MCP tool and not a button: nothing about it is a decision
 * a human or an agent makes per task, so it runs unattended on the hourly
 * `taskBoardArchiveSweepWorkflow` (see `dbos-archive-sweep.ts`). Manual
 * archiving already exists without any code of its own — drag a card into the
 * Archived lane, or pick Archived in the card's status menu.
 *
 * Archiving is a plain status move (no `archived_at` column): the activity
 * timeline records the move like any other, so archive/unarchive cycles are
 * history for free and dragging a card back out un-archives it.
 */

import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItemPrRef } from "@/storage/types";
import { recordTaskActivity } from "./activity";
import { fetchPrMerged } from "./prs-get";
import { emitTaskBoardUpdated } from "./run-reactions";

/** How the sweep asks GitHub whether a PR merged — a parameter only so a
 *  local/CI harness can drive the archive path without a GitHub connection. */
type PrMergedReader = (
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
) => Promise<boolean | null>;

/**
 * Is this Done card's work landed? Every linked PR merged, and at least one
 * linked. No PRs means there's nothing to verify — a design/research task is
 * left in Done for a human to archive. `null` (GitHub unreachable) is never read
 * as merged, so a bad fetch defers the archive to the next sweep instead of
 * archiving on a guess.
 */
export function allPrsMerged(merged: (boolean | null)[]): boolean {
  return merged.length > 0 && merged.every((m) => m === true);
}

/**
 * Archive one candidate if its PRs are all merged. Returns whether it moved.
 *
 * Re-reads the card inside the org's context and re-checks `status === "done"`:
 * the sweep's work list is a snapshot, and a card someone dragged out of Done
 * (or another replica already archived) in the meantime must not be moved.
 */
async function archiveIfMerged(
  ctx: StudioContext,
  organizationId: string,
  itemId: string,
  prMerged: PrMergedReader,
): Promise<boolean> {
  const item = await ctx.storage.taskBoard.getById(itemId, organizationId);
  if (!item || item.status !== "done") return false;

  const prs = await ctx.storage.taskBoard.listPrs(itemId, organizationId);
  const merged = await Promise.all(
    prs.map((pr) => prMerged(ctx, organizationId, pr)),
  );
  if (!allPrsMerged(merged)) return false;

  const updated = await ctx.storage.taskBoard.update(
    itemId,
    organizationId,
    { status: "archived" },
    item.updatedBy,
  );
  await recordTaskActivity(ctx, {
    taskBoardItemId: itemId,
    action: "status_changed",
    actorId: null,
    data: { from: "done", to: "archived", reason: "merged_pr_auto_archive" },
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
export async function archiveMergedForOrg(
  ctx: StudioContext,
  organizationId: string,
  itemIds: string[],
  prMerged: PrMergedReader = fetchPrMerged,
): Promise<{ archived: number }> {
  let archived = 0;
  for (const itemId of itemIds) {
    try {
      if (await archiveIfMerged(ctx, organizationId, itemId, prMerged)) {
        archived += 1;
      }
    } catch (err) {
      console.error(`[task-board-archive] ${itemId} failed`, err);
    }
  }
  return { archived };
}

/** Candidate ids grouped by org, so each org's leg is one parallel step. */
export function groupByOrg(
  candidates: { id: string; organizationId: string }[],
): { organizationId: string; itemIds: string[] }[] {
  const byOrg = new Map<string, string[]>();
  for (const { id, organizationId } of candidates) {
    const ids = byOrg.get(organizationId);
    if (ids) ids.push(id);
    else byOrg.set(organizationId, [id]);
  }
  return [...byOrg].map(([organizationId, itemIds]) => ({
    organizationId,
    itemIds,
  }));
}
