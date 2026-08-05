import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";

/**
 * Dismissed diagnostic findings — the undo side of deleting a reports-pushed
 * card. Deleting such a card tombstones the finding's `external_key` so the
 * next import skips it (see storage/task-board.ts `delete`); these two tools
 * make that state visible and reversible.
 */

const DismissedFindingSchema = z.object({
  externalKey: z.string(),
  dismissedBy: z.string(),
  dismissedAt: z.string(),
});

function requireOrg(organizationId: string | undefined): string {
  if (!organizationId) {
    throw new Error(
      "Organization ID required (no active organization in context)",
    );
  }
  return organizationId;
}

export const TASK_BOARD_DISMISSED_LIST = defineTool({
  name: "TASK_BOARD_DISMISSED_LIST",
  description:
    "List the diagnostic findings this organization has dismissed by deleting " +
    "their task board cards. The import skips these until they're restored.",
  annotations: {
    title: "List Dismissed Findings",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({ findings: z.array(DismissedFindingSchema) }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = requireOrg(ctx.organization?.id);
    const findings =
      await ctx.storage.taskBoard.listDismissedFindings(organizationId);
    return { findings };
  },
});

export const TASK_BOARD_DISMISSED_RESTORE = defineTool({
  name: "TASK_BOARD_DISMISSED_RESTORE",
  description:
    "Un-dismiss diagnostic findings so the next report import pushes them to " +
    "the board again. Omit externalKeys to restore every dismissed finding.",
  annotations: {
    title: "Restore Dismissed Findings",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    /** Omitted restores everything; an empty array restores nothing, so a
     *  caller filtering a list down to zero can't accidentally clear the lot. */
    externalKeys: z.array(z.string()).optional(),
  }),
  outputSchema: z.object({ restored: z.number() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = requireOrg(ctx.organization?.id);
    const restored = await ctx.storage.taskBoard.restoreDismissedFindings(
      organizationId,
      input.externalKeys,
    );
    return { restored };
  },
});
