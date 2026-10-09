/**
 * Sprint tools: plan, start and complete the sprints a board's cards are
 * planned into. A card's own sprint is set through TASK_BOARD_ITEM_CREATE and
 * TASK_BOARD_ITEM_UPDATE (`sprintId`).
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  type StudioContext,
} from "@/core/studio-context";
import { sseHub } from "@/event-bus/sse-hub";
import {
  isCalendarDay,
  MAX_SPRINT_NAME_LENGTH,
  nextSprintId,
  type Sprint,
} from "@decocms/shared/sprints";
import { TASK_BOARD_SPRINTS_UPDATED_EVENT } from "@decocms/shared/task-board";
import type { TaskBoardActivityAction } from "@/storage/types";
import { recordTaskActivities } from "./activity";
import { SprintSchema } from "./schema";

const SprintNameSchema = z.string().trim().min(1).max(MAX_SPRINT_NAME_LENGTH);

const CalendarDaySchema = z
  .string()
  .refine(isCalendarDay, "Expected a calendar day as YYYY-MM-DD");

function orgIdOf(ctx: StudioContext): string {
  const organizationId = ctx.organization?.id;
  if (!organizationId) {
    throw new Error(
      "Organization ID required (no active organization in context)",
    );
  }
  return organizationId;
}

function assertOrderedDays(
  startDate: string | null,
  endDate: string | null,
): void {
  if (startDate !== null && endDate !== null && endDate < startDate) {
    throw new Error("endDate must be on or after startDate");
  }
}

/** Tell open boards the sprint list changed, so they re-read it and the cards
 *  a completion or a delete moved. */
function emitTaskBoardSprintsUpdated(orgId: string, sprintId: string): void {
  sseHub.emit(orgId, {
    id: crypto.randomUUID(),
    type: TASK_BOARD_SPRINTS_UPDATED_EVENT,
    source: "task-board",
    subject: sprintId,
    data: { sprintId },
    time: new Date().toISOString(),
  });
}

/** Refuses a sprint that is not this org's, or that is closed. */
export async function assertPlannableSprint(
  ctx: StudioContext,
  organizationId: string,
  sprintId: string,
): Promise<void> {
  const sprint = await ctx.storage.sprints.get(organizationId, sprintId);
  if (!sprint) {
    throw new Error(`Sprint not found: ${sprintId}`);
  }
  if (sprint.state === "closed") {
    throw new Error(
      `Sprint "${sprint.name}" is closed — plan the card into a running or planned sprint`,
    );
  }
}

/**
 * The timeline entry for a card moving between sprints. Names are copied in
 * so the entry still reads after the sprint is renamed or deleted.
 */
export function sprintChangeEntry(
  sprints: readonly Sprint[],
  fromId: string | null,
  toId: string | null,
): { action: TaskBoardActivityAction; data: Record<string, unknown> } {
  const ref = (id: string | null) => {
    if (id === null) return null;
    const sprint = sprints.find((candidate) => candidate.id === id);
    return { id, name: sprint?.name ?? null };
  };
  return {
    action: "sprint_changed",
    data: { from: ref(fromId), to: ref(toId) },
  };
}

/** Log a bulk move: every card in `itemIds` went from `fromId` to `toId`. */
async function recordSprintMoves(
  ctx: StudioContext,
  sprints: readonly Sprint[],
  itemIds: readonly string[],
  fromId: string,
  toId: string | null,
): Promise<void> {
  const entry = sprintChangeEntry(sprints, fromId, toId);
  await recordTaskActivities(
    ctx,
    itemIds.map((taskBoardItemId) => ({
      taskBoardItemId,
      actorId: getUserId(ctx)!,
      ...entry,
    })),
  );
}

export const TASK_BOARD_SPRINT_LIST = defineTool({
  name: "TASK_BOARD_SPRINT_LIST",
  description:
    "List the board's sprints: running first, then planned (soonest first), " +
    "then closed (most recent first). A card's `sprintId` is one of these ids.",
  annotations: {
    title: "List Sprints",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({ sprints: z.array(SprintSchema) }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    return { sprints: await ctx.storage.sprints.listByOrg(orgIdOf(ctx)) };
  },
});

export const TASK_BOARD_SPRINT_CREATE = defineTool({
  name: "TASK_BOARD_SPRINT_CREATE",
  description:
    "Plan a new sprint. It starts as planned (`future`); start it with " +
    "TASK_BOARD_SPRINT_START.",
  annotations: {
    title: "Create Sprint",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    name: SprintNameSchema,
    startDate: CalendarDaySchema.nullable().optional(),
    endDate: CalendarDaySchema.nullable().optional(),
  }),
  outputSchema: z.object({ sprint: SprintSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = orgIdOf(ctx);
    const startDate = input.startDate ?? null;
    const endDate = input.endDate ?? null;
    assertOrderedDays(startDate, endDate);
    const sprint = await ctx.storage.sprints.create({
      organizationId,
      name: input.name,
      startDate,
      endDate,
      by: getUserId(ctx)!,
    });
    emitTaskBoardSprintsUpdated(organizationId, sprint.id);
    return { sprint };
  },
});

export const TASK_BOARD_SPRINT_UPDATE = defineTool({
  name: "TASK_BOARD_SPRINT_UPDATE",
  description:
    "Rename a sprint or change its dates. Pass null to clear a date.",
  annotations: {
    title: "Update Sprint",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
    name: SprintNameSchema.optional(),
    startDate: CalendarDaySchema.nullable().optional(),
    endDate: CalendarDaySchema.nullable().optional(),
  }),
  outputSchema: z.object({ sprint: SprintSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = orgIdOf(ctx);
    const current = await ctx.storage.sprints.get(organizationId, input.id);
    if (!current) throw new Error(`Sprint not found: ${input.id}`);
    assertOrderedDays(
      input.startDate === undefined ? current.startDate : input.startDate,
      input.endDate === undefined ? current.endDate : input.endDate,
    );
    const sprint = await ctx.storage.sprints.update(organizationId, input.id, {
      name: input.name,
      startDate: input.startDate,
      endDate: input.endDate,
    });
    if (!sprint) throw new Error(`Sprint not found: ${input.id}`);
    emitTaskBoardSprintsUpdated(organizationId, sprint.id);
    return { sprint };
  },
});

export const TASK_BOARD_SPRINT_START = defineTool({
  name: "TASK_BOARD_SPRINT_START",
  description:
    "Start a planned sprint. The board opens on the running sprint by default.",
  annotations: {
    title: "Start Sprint",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ sprint: SprintSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = orgIdOf(ctx);
    const sprint = await ctx.storage.sprints.start(organizationId, input.id);
    if (!sprint) {
      const current = await ctx.storage.sprints.get(organizationId, input.id);
      throw new Error(
        current
          ? `Sprint "${current.name}" is ${current.state === "active" ? "already running" : "closed"}`
          : `Sprint not found: ${input.id}`,
      );
    }
    emitTaskBoardSprintsUpdated(organizationId, sprint.id);
    return { sprint };
  },
});

export const TASK_BOARD_SPRINT_COMPLETE = defineTool({
  name: "TASK_BOARD_SPRINT_COMPLETE",
  description:
    "Complete a running sprint. Cards that are not Done or Archived move on: " +
    "by default to the next planned sprint (the soonest), or to the backlog " +
    "when none is planned. Done and Archived cards stay as the sprint's record.",
  annotations: {
    title: "Complete Sprint",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
    moveOpenTo: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Where unfinished cards go: a planned or running sprint's id, or null " +
          "for the backlog. Omit for the next planned sprint.",
      ),
  }),
  outputSchema: z.object({
    sprint: SprintSchema,
    /** The sprint the unfinished cards went to; null = backlog. */
    movedTo: z.string().nullable(),
    movedCount: z.number(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = orgIdOf(ctx);
    const sprints = await ctx.storage.sprints.listByOrg(organizationId);
    const current = sprints.find((sprint) => sprint.id === input.id);
    if (!current) throw new Error(`Sprint not found: ${input.id}`);
    if (input.moveOpenTo === input.id) {
      throw new Error("moveOpenTo must be a different sprint");
    }
    const moveTo =
      input.moveOpenTo === undefined
        ? nextSprintId(sprints, input.id)
        : input.moveOpenTo;

    const completion = await ctx.storage.sprints.complete({
      organizationId,
      id: input.id,
      moveTo,
      by: getUserId(ctx)!,
    });
    if (!completion) {
      throw new Error(
        `Sprint "${current.name}" is ${current.state === "future" ? "not started" : "already completed"}`,
      );
    }
    await recordSprintMoves(
      ctx,
      sprints,
      completion.movedItemIds,
      input.id,
      completion.movedTo,
    );
    emitTaskBoardSprintsUpdated(organizationId, input.id);
    return {
      sprint: completion.sprint,
      movedTo: completion.movedTo,
      movedCount: completion.movedItemIds.length,
    };
  },
});

export const TASK_BOARD_SPRINT_DELETE = defineTool({
  name: "TASK_BOARD_SPRINT_DELETE",
  description:
    "Delete a sprint. Every card in it, finished or not, goes to the backlog; " +
    "no card is deleted.",
  annotations: {
    title: "Delete Sprint",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ deleted: z.boolean(), movedCount: z.number() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = orgIdOf(ctx);
    const sprints = await ctx.storage.sprints.listByOrg(organizationId);
    const removed = await ctx.storage.sprints.delete(organizationId, input.id);
    if (!removed) return { deleted: false, movedCount: 0 };
    await recordSprintMoves(ctx, sprints, removed.movedItemIds, input.id, null);
    emitTaskBoardSprintsUpdated(organizationId, input.id);
    return { deleted: true, movedCount: removed.movedItemIds.length };
  },
});
