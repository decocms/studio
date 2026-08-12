/**
 * Archive the org's Done tasks whose work actually landed.
 *
 * "Done" accumulates forever — a board with 77 cards in Done is a board nobody
 * reads. A task whose linked PRs are all merged is finished by evidence, not by
 * someone's memory, so it moves to the Archived lane. Archiving is a plain
 * status move (no `archived_at` column): the timeline already records every
 * move as `status_changed`, so archive/unarchive cycles are history for free,
 * and dragging the card back out un-archives it with no extra code.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import { recordTaskActivity } from "./activity";
import { fetchPrMerged } from "./prs-get";
import { emitTaskBoardUpdated } from "./run-reactions";

/**
 * Is this Done task's work landed? Every linked PR merged, and at least one
 * linked. No PRs means there's nothing to verify — a design/research task is
 * left in Done for a human to archive. `null` (GitHub unreachable) is never
 * read as merged, so a bad fetch defers the archive to the next run instead of
 * archiving on a guess.
 */
export function allPrsMerged(merged: (boolean | null)[]): boolean {
  return merged.length > 0 && merged.every((m) => m === true);
}

export const TASK_BOARD_ARCHIVE_MERGED = defineTool({
  name: "TASK_BOARD_ARCHIVE_MERGED",
  description:
    "Archive every Done task in the organization whose linked GitHub pull " +
    "requests have all been merged. Tasks with no linked PR are left alone.",
  annotations: {
    title: "Archive Merged Done Tasks",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    /** Ceiling on tasks inspected per call — each costs one GitHub read per
     *  linked PR. Re-run to work through a bigger backlog. */
    limit: z.number().int().min(1).max(200).default(50),
  }),
  outputSchema: z.object({
    scanned: z.number(),
    archivedIds: z.array(z.string()),
  }),
  handler: async ({ limit }, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const done = (await ctx.storage.taskBoard.list(organizationId))
      .filter((item) => item.status === "done")
      .slice(0, limit);

    const archivedIds: string[] = [];
    // ponytail: task-at-a-time — GitHub's secondary rate limit punishes bursts.
    for (const item of done) {
      const prs = await ctx.storage.taskBoard.listPrs(item.id, organizationId);
      const merged = await Promise.all(
        prs.map((pr) => fetchPrMerged(ctx, organizationId, pr)),
      );
      if (!allPrsMerged(merged)) continue;

      const updated = await ctx.storage.taskBoard.update(
        item.id,
        organizationId,
        { status: "archived" },
        item.updatedBy,
      );
      await recordTaskActivity(ctx, {
        taskBoardItemId: item.id,
        action: "status_changed",
        actorId: null,
        data: { from: "done", to: "archived" },
      });
      emitTaskBoardUpdated(organizationId, updated);
      archivedIds.push(item.id);
    }

    return { scanned: done.length, archivedIds };
  },
});
