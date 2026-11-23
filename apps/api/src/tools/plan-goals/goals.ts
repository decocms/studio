/**
 * Plan goal tools. Any member reads the org's goals, adds one, and picks the
 * one they work toward; rewording or archiving a goal is for its creator or an
 * admin, so nobody changes the goal other people work toward from under them.
 * The author and time of every write come from the session.
 */

import { z } from "zod";
import { hasAdminRole } from "@decocms/shared/auth/roles";
import {
  MAX_OPEN_PLAN_GOALS,
  PlanGoalSchema,
  PlanGoalSourceSchema,
  PlanGoalStatementSchema,
} from "@decocms/shared/plan-goals";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "@/core/studio-context";
import type { StoredPlanGoal } from "@/storage/plan-goals";
import { emitPlanGoalsUpdated } from "./events";

/** Cases the Plan page lists for one goal. */
const MAX_GOAL_CASES = 50;

const GoalIdSchema = z.string().min(1).max(128).describe("A goal's id.");

const ThreadIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .max(128)
  .describe("The id of the business case's chat.");

/** The org and the signed-in caller every goal tool acts for. */
async function caller(ctx: StudioContext) {
  requireAuth(ctx);
  await ctx.access.check();
  const org = requireOrganization(ctx);
  const userId = getUserId(ctx);
  if (!userId) throw new Error("A signed-in user is required");
  return { orgId: org.id, userId, admin: hasAdminRole(ctx.access.getRole()) };
}

/** The open goal the caller may reword or archive; throws otherwise. */
async function editableGoal(
  ctx: StudioContext,
  who: { orgId: string; userId: string; admin: boolean },
  id: string,
): Promise<StoredPlanGoal> {
  const goal = await ctx.storage.planGoals.get(who.orgId, id);
  if (!goal?.open) throw new Error(`Goal not found: ${id}`);
  if (!who.admin && goal.created_by !== who.userId) {
    throw new Error(
      "Only the person who created this goal, or an admin, can change it. Create your own goal instead.",
    );
  }
  return goal;
}

export const PLAN_GOAL_LIST = defineTool({
  name: "PLAN_GOAL_LIST",
  description:
    "List the organization's open Plan goals, with how many people work toward each, and the goal the caller works toward.",
  annotations: {
    title: "List Plan Goals",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    goals: z.array(PlanGoalSchema),
    active_goal_id: z
      .string()
      .nullable()
      .describe(
        "The goal the caller's Plan page opens on; null with no goals.",
      ),
  }),
  handler: async (_input, ctx) => {
    const who = await caller(ctx);
    let goals = await ctx.storage.planGoals.list(
      who.orgId,
      who.userId,
      who.admin,
    );
    if (goals.length === 0) {
      const settings = await ctx.storage.organizationSettings.get(who.orgId);
      if (settings?.plan_objective) {
        await ctx.storage.planGoals.seedFromObjective(
          who.orgId,
          settings.plan_objective,
        );
        goals = await ctx.storage.planGoals.list(
          who.orgId,
          who.userId,
          who.admin,
        );
      }
    }
    const active_goal_id = goals.length
      ? await ctx.storage.planGoals.activeGoalId(who.orgId, who.userId)
      : null;
    return { goals, active_goal_id };
  },
});

export const PLAN_GOAL_CREATE = defineTool({
  name: "PLAN_GOAL_CREATE",
  description:
    "Add a goal to the organization's Plan goals and make it the one the caller works toward. From a chat, save only a sentence the person approved there.",
  annotations: {
    title: "Create Plan Goal",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    statement: PlanGoalStatementSchema,
    source: PlanGoalSourceSchema.nullish().describe(
      "Where the AI found the goal; leave out when the person wrote it.",
    ),
    make_active: z
      .boolean()
      .default(true)
      .describe("Make it the goal the caller's Plan page opens on."),
  }),
  outputSchema: z.object({ id: z.string() }),
  handler: async (input, ctx) => {
    const who = await caller(ctx);
    const id = await ctx.storage.planGoals.create({
      organizationId: who.orgId,
      statement: input.statement,
      source: input.source ?? null,
      by: who.userId,
    });
    if (!id) {
      throw new Error(
        `The organization already has ${MAX_OPEN_PLAN_GOALS} open goals. Archive one before adding another.`,
      );
    }
    if (input.make_active) {
      await ctx.storage.planGoals.setActive(who.orgId, who.userId, id);
    }
    emitPlanGoalsUpdated(who.orgId, id);
    return { id };
  },
});

export const PLAN_GOAL_UPDATE = defineTool({
  name: "PLAN_GOAL_UPDATE",
  description:
    "Reword one of the organization's Plan goals. Only its creator or an admin may.",
  annotations: {
    title: "Update Plan Goal",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: GoalIdSchema,
    statement: PlanGoalStatementSchema,
  }),
  outputSchema: z.object({ id: z.string() }),
  handler: async (input, ctx) => {
    const who = await caller(ctx);
    await editableGoal(ctx, who, input.id);
    const updated = await ctx.storage.planGoals.updateStatement(
      who.orgId,
      input.id,
      input.statement,
      who.userId,
    );
    if (!updated) throw new Error(`Goal not found: ${input.id}`);
    emitPlanGoalsUpdated(who.orgId, input.id);
    return { id: input.id };
  },
});

export const PLAN_GOAL_ARCHIVE = defineTool({
  name: "PLAN_GOAL_ARCHIVE",
  description:
    "Archive one of the organization's Plan goals: it leaves the picker, and whoever worked toward it goes back to the default. Business cases keep it. Only its creator or an admin may.",
  annotations: {
    title: "Archive Plan Goal",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ id: GoalIdSchema }),
  outputSchema: z.object({ id: z.string() }),
  handler: async (input, ctx) => {
    const who = await caller(ctx);
    await editableGoal(ctx, who, input.id);
    const archived = await ctx.storage.planGoals.archive(
      who.orgId,
      input.id,
      who.userId,
    );
    if (!archived) throw new Error(`Goal not found: ${input.id}`);
    emitPlanGoalsUpdated(who.orgId, input.id);
    return { id: input.id };
  },
});

export const PLAN_ACTIVE_GOAL_SET = defineTool({
  name: "PLAN_ACTIVE_GOAL_SET",
  description:
    "Pick the Plan goal the caller works toward; their Plan page opens on it.",
  annotations: {
    title: "Pick Plan Goal",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ goal_id: GoalIdSchema }),
  outputSchema: z.object({ goal_id: z.string() }),
  handler: async (input, ctx) => {
    const who = await caller(ctx);
    const set = await ctx.storage.planGoals.setActive(
      who.orgId,
      who.userId,
      input.goal_id,
    );
    if (!set) throw new Error(`Goal not found: ${input.goal_id}`);
    emitPlanGoalsUpdated(who.orgId, input.goal_id);
    return { goal_id: input.goal_id };
  },
});

export const PLAN_GOAL_CASE_RECORD = defineTool({
  name: "PLAN_GOAL_CASE_RECORD",
  description:
    "Record that a business case chat was started toward a Plan goal. The first record of a chat stands.",
  annotations: {
    title: "Record Plan Case Goal",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ goal_id: GoalIdSchema, thread_id: ThreadIdSchema }),
  outputSchema: z.object({ goal_id: z.string() }),
  handler: async (input, ctx) => {
    const who = await caller(ctx);
    const recorded = await ctx.storage.planGoals.recordCase({
      organizationId: who.orgId,
      threadId: input.thread_id,
      goalId: input.goal_id,
      userId: who.userId,
    });
    if (!recorded) throw new Error(`Goal not found: ${input.goal_id}`);
    emitPlanGoalsUpdated(who.orgId, input.goal_id);
    return { goal_id: input.goal_id };
  },
});

export const PLAN_GOAL_CASES = defineTool({
  name: "PLAN_GOAL_CASES",
  description:
    "List the business case chats anyone in the organization started toward a Plan goal, newest first.",
  annotations: {
    title: "List Plan Goal Cases",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ goal_id: GoalIdSchema }),
  outputSchema: z.object({ thread_ids: z.array(z.string()) }),
  handler: async (input, ctx) => {
    const who = await caller(ctx);
    return {
      thread_ids: await ctx.storage.planGoals.caseThreadIds(
        who.orgId,
        input.goal_id,
        MAX_GOAL_CASES,
      ),
    };
  },
});
