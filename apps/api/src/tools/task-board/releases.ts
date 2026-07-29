/**
 * Releases — optional packaging of finished tasks behind the org's
 * `releasesEnabled` board setting. Creating a release stamps the selected
 * tasks with its id; deleting one unstamps them.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import { TaskBoardReleaseSchema } from "./schema";

export const TASK_BOARD_RELEASE_CREATE = defineTool({
  name: "TASK_BOARD_RELEASE_CREATE",
  description:
    "Create a release from a set of task board items (stamps each task with the release).",
  annotations: {
    title: "Create Release",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    title: z.string().min(1).max(200),
    notes: z.string().max(20_000).nullable().optional(),
    taskIds: z.array(z.string()).min(1).max(200),
  }),
  outputSchema: z.object({ release: TaskBoardReleaseSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }
    const release = await ctx.storage.taskBoard.createRelease({
      organizationId,
      title: input.title,
      notes: input.notes ?? null,
      taskIds: input.taskIds,
      by: getUserId(ctx)!,
    });
    return { release };
  },
});

export const TASK_BOARD_RELEASE_LIST = defineTool({
  name: "TASK_BOARD_RELEASE_LIST",
  description: "List the organization's releases (most recent first).",
  annotations: {
    title: "List Releases",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({ releases: z.array(TaskBoardReleaseSchema) }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }
    const releases = await ctx.storage.taskBoard.listReleases(organizationId);
    return { releases };
  },
});

export const TASK_BOARD_RELEASE_DELETE = defineTool({
  name: "TASK_BOARD_RELEASE_DELETE",
  description:
    "Delete a release. Its tasks are kept and lose the release stamp.",
  annotations: {
    title: "Delete Release",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ success: z.boolean() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }
    await ctx.storage.taskBoard.deleteRelease(input.id, organizationId);
    return { success: true };
  },
});
