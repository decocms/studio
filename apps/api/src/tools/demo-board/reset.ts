/**
 * Returns a demo org's board to its snapshot, then tidies what the database
 * cannot: pull requests a live card opened since the capture are closed and
 * their branches deleted, open boards are told to refetch, and each frozen
 * card's preview is probed so a dead one is reported before a demo finds it.
 */

import { mapBounded } from "@decocms/shared/std";
import type { StudioContext } from "@/core/studio-context";
import { changeRequestClientForOrigin } from "@/git-providers";
import { originOf } from "../task-board/change-request-extract";
import { probePreview } from "../task-board/preview-probe";
import { invalidatePrCards } from "../task-board/prs-get";
import {
  emitTaskBoardDeleted,
  emitTaskBoardUpdated,
} from "../task-board/run-reactions";

export interface DemoBoardResetResult {
  restoredItems: number;
  deletedItems: number;
  closedPrs: number;
  /** Pull requests that stayed open, with why. */
  problems: string[];
  deadPreviewUrls: string[];
}

const PROBE_CONCURRENCY = 4;

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Null when the org never captured a board. */
export async function resetDemoBoard(
  ctx: StudioContext,
  organizationId: string,
  now: Date = new Date(),
): Promise<DemoBoardResetResult | null> {
  const storage = ctx.storage.demoBoard;
  const restore = await storage
    .restore(organizationId, now)
    .catch(async (err: unknown) => {
      await storage
        .recordReset(organizationId, {
          at: now,
          error: messageOf(err),
          deadPreviewUrls: [],
        })
        .catch(() => {});
      throw err;
    });
  if (!restore) return null;

  const problems: string[] = [];
  let closedPrs = 0;
  for (const pr of restore.prsToClose) {
    try {
      const client = await changeRequestClientForOrigin(
        ctx,
        organizationId,
        originOf(pr),
      );
      if (!client) throw new Error("no credential for its repository");
      await client.close(pr.number);
      closedPrs++;
    } catch (err) {
      problems.push(`${pr.url}: ${messageOf(err)}`);
    }
  }

  await invalidatePrCards(organizationId);
  for (const id of restore.deletedItemIds) {
    emitTaskBoardDeleted(organizationId, id);
  }
  for (const id of [...restore.restoredItemIds, ...restore.rearchivedItemIds]) {
    const item = await ctx.storage.taskBoard.getById(id, organizationId);
    if (item) emitTaskBoardUpdated(organizationId, item);
  }

  const { previewUrls } = restore;
  const probes = await mapBounded(previewUrls, PROBE_CONCURRENCY, probePreview);
  const deadPreviewUrls = previewUrls.filter((_, i) => !probes[i]?.available);

  await storage.recordReset(organizationId, {
    at: now,
    error: problems.length > 0 ? problems.join("\n") : null,
    deadPreviewUrls,
  });
  if (problems.length > 0 || deadPreviewUrls.length > 0) {
    console.warn(
      `[demo-board] reset of ${organizationId} left ${problems.length} pull request(s) open and ${deadPreviewUrls.length} dead preview(s)`,
    );
  }
  return {
    restoredItems: restore.restoredItemIds.length,
    deletedItems: restore.deletedItemIds.length,
    closedPrs,
    problems,
    deadPreviewUrls,
  };
}
