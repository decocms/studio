/**
 * Sprints — optional planning cycles behind the org's `sprintsEnabled` board
 * setting. Tasks reference a sprint via `sprintId`; deleting a sprint returns
 * its tasks to the backlog (no sprint).
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { getUserId, requireAuth } from "@/core/studio-context";
import { TaskBoardSprintSchema, TaskBoardSprintStateSchema } from "./schema";

export const TASK_BOARD_SPRINT_CREATE = defineTool({
  name: "TASK_BOARD_SPRINT_CREATE",
  description: "Create a sprint for the organization's task board.",
  annotations: {
    title: "Create Sprint",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    name: z.string().min(1).max(120),
    state: TaskBoardSprintStateSchema.optional(),
    startDate: z.string().datetime().nullable().optional(),
    endDate: z.string().datetime().nullable().optional(),
  }),
  outputSchema: z.object({ sprint: TaskBoardSprintSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }
    const sprint = await ctx.storage.taskBoard.createSprint({
      organizationId,
      name: input.name,
      state: input.state,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      by: getUserId(ctx)!,
    });
    return { sprint };
  },
});

export const TASK_BOARD_SPRINT_UPDATE = defineTool({
  name: "TASK_BOARD_SPRINT_UPDATE",
  description:
    "Update a sprint's name, state (planned/active/closed) or dates.",
  annotations: {
    title: "Update Sprint",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
    name: z.string().min(1).max(120).optional(),
    state: TaskBoardSprintStateSchema.optional(),
    startDate: z.string().datetime().nullable().optional(),
    endDate: z.string().datetime().nullable().optional(),
  }),
  outputSchema: z.object({ sprint: TaskBoardSprintSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }
    const sprint = await ctx.storage.taskBoard.updateSprint(
      input.id,
      organizationId,
      {
        name: input.name,
        state: input.state,
        startDate: input.startDate,
        endDate: input.endDate,
      },
    );
    return { sprint };
  },
});

export const TASK_BOARD_SPRINT_DELETE = defineTool({
  name: "TASK_BOARD_SPRINT_DELETE",
  description:
    "Delete a sprint. Its tasks are kept and returned to the backlog (no sprint).",
  annotations: {
    title: "Delete Sprint",
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
    await ctx.storage.taskBoard.deleteSprint(input.id, organizationId);
    return { success: true };
  },
});

export const TASK_BOARD_SPRINT_LIST = defineTool({
  name: "TASK_BOARD_SPRINT_LIST",
  description:
    "List the organization's sprints (active first, then planned, then closed).",
  annotations: {
    title: "List Sprints",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({ sprints: z.array(TaskBoardSprintSchema) }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }
    const sprints = await ctx.storage.taskBoard.listSprints(organizationId);
    return { sprints };
  },
});
