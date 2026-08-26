/**
 * Auto-archive: a Done card whose PRs landed and which nobody has touched for
 * five days is history, and history belongs in the Archived lane rather than in
 * a Done column with 77 cards nobody reads.
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
import { fetchPrLanding } from "./prs-get";
import { emitTaskBoardUpdated } from "./run-reactions";

/** What {@link cardWorkLanded} needs to know about one linked PR: the repo it
 *  targets, and whether it is still in play. */
export interface PrLanding {
  repoOwner: string;
  repoName: string;
  state: "open" | "closed" | null;
  merged: boolean | null;
}

/** How a sweep asks GitHub where a PR stands — a parameter only so a local/CI
 *  harness can drive the path without a GitHub connection. Shared with the
 *  merged-tag sweep, which gates on the same question. */
export type PrLandingReader = (
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
) => Promise<Pick<PrLanding, "state" | "merged">>;

/**
 * Has this card's work landed?
 *
 * Per REPOSITORY, not per PR. A card carries several PRs for two unrelated
 * reasons and the old "every linked PR merged" rule conflated them. A reviewer
 * bounce that opens a fresh PR instead of pushing to the reviewed branch leaves
 * the abandoned one closed-and-unmerged forever, so `every(merged)` could never
 * be satisfied and the card was stranded out of the archive, the merged tag and
 * the reconcile permanently — while `pickActivePr`, asking the neighbouring
 * question, reads exactly the same list as a retry history. A card touching two
 * repos, meanwhile, genuinely does need both to land.
 *
 * So each repo the card has PRs in needs one merged and none still in play.
 * Note this cannot be answered from `merged` alone: closed-unmerged and still
 * open both report `merged: false`, and only the first is settled.
 *
 * "In play" is deliberately generous — an unreadable PR (`state: null`) counts
 * as outstanding, so a GitHub blip defers rather than landing a card on a
 * guess. Same conservative direction the previous rule took with `merged: null`.
 *
 * No PRs at all means there is nothing to verify: a design or research task is
 * left for a human, never landed automatically.
 */
export function cardWorkLanded(prs: PrLanding[]): boolean {
  if (prs.length === 0) return false;
  const byRepo = new Map<string, PrLanding[]>();
  for (const pr of prs) {
    // GitHub treats owner/name case-insensitively, and the two spellings can
    // reach us from different places (a parsed URL vs a connection's scope).
    const key = `${pr.repoOwner}/${pr.repoName}`.toLowerCase();
    const group = byRepo.get(key);
    if (group) group.push(pr);
    else byRepo.set(key, [pr]);
  }
  return [...byRepo.values()].every(repoLanded);
}

/** One repo's PRs on a card: one of them merged, and none left in play.
 *  `merged === true` also passes the second test on its own, for the partial
 *  read that reports a merge without a state. */
function repoLanded(prs: PrLanding[]): boolean {
  return (
    prs.some((pr) => pr.merged === true) &&
    prs.every((pr) => pr.merged === true || pr.state === "closed")
  );
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
  prLanding: PrLandingReader,
): Promise<boolean> {
  const item = await ctx.storage.taskBoard.getById(itemId, organizationId);
  if (!item || item.status !== "done") return false;

  const prs = await ctx.storage.taskBoard.listPrs(itemId, organizationId);
  const landings = await Promise.all(
    prs.map(async (pr) => ({
      ...pr,
      ...(await prLanding(ctx, organizationId, pr)),
    })),
  );
  if (!cardWorkLanded(landings)) return false;

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
  prLanding: PrLandingReader = fetchPrLanding,
): Promise<{ archived: number }> {
  let archived = 0;
  for (const itemId of itemIds) {
    try {
      if (await archiveIfMerged(ctx, organizationId, itemId, prLanding)) {
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
