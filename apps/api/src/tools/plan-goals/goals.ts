/**
 * Plan goal tools. Any member reads the org's goals, adds one, and picks the
 * one they work toward; rewording or archiving a goal is for its creator or an
 * admin, so nobody changes the goal other people work toward from under them.
 * The author and time of every write come from the session.
 */

import { z } from "zod";
import { hasAdminRole } from "@decocms/shared/auth/roles";
import {
  MAX_DISMISSED_PLAN_GOAL_PAIRS,
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
import {
  confirmSameGoals,
  planGoalPairKey,
  prefilterGoalPairs,
  prefilterSimilarGoals,
} from "./similar";

/** Cases the Plan page lists for one goal. */
const MAX_GOAL_CASES = 50;

/** How long creating a goal may wait on the model's "same goal?" answer. */
const SIMILAR_TIMEOUT_MS = 4_000;

/** Nobody waits on a consolidation proposal, so the model gets longer. */
const DUPLICATES_TIMEOUT_MS = 10_000;

/** Pairs proposed for a merge at once; more come after these are handled. */
const MAX_DUPLICATE_PAIRS = 10;

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

const SimilarGoalSchema = PlanGoalSchema.pick({
  id: true,
  statement: true,
  users: true,
  created_by: true,
  created_at: true,
});

export const PLAN_GOAL_SIMILAR = defineTool({
  name: "PLAN_GOAL_SIMILAR",
  description:
    "Before adding a Plan goal: the organization's open goals that already say the same thing, so the person can work toward one of those instead. The same sentence typed differently always matches; a reworded one matches when the fast model is sure. Saves nothing, and an empty list never stops anyone from creating their goal.",
  annotations: {
    title: "Find Similar Plan Goals",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    statement: PlanGoalStatementSchema,
    exclude_id: GoalIdSchema.optional().describe(
      "A goal to leave out, such as the one being reworded.",
    ),
  }),
  outputSchema: z.object({
    matches: z
      .array(SimilarGoalSchema)
      .describe("The same sentence first, then the ones the model matched."),
  }),
  handler: async (input, ctx, call) => {
    const who = await caller(ctx);
    const goals = (
      await ctx.storage.planGoals.list(who.orgId, who.userId, who.admin)
    ).filter((goal) => goal.id !== input.exclude_id);
    const { exact, candidates } = prefilterSimilarGoals(input.statement, goals);
    const same = await confirmSameGoals(
      ctx,
      who.orgId,
      candidates.map((goal) => ({ a: input.statement, b: goal.statement })),
      SIMILAR_TIMEOUT_MS,
      call?.signal,
    );
    return {
      matches: [...exact, ...candidates.filter((_, i) => same[i])].map((goal) =>
        SimilarGoalSchema.parse(goal),
      ),
    };
  },
});

export const PLAN_GOAL_DUPLICATES = defineTool({
  name: "PLAN_GOAL_DUPLICATES",
  description:
    "Pairs of the organization's open Plan goals that look like the same goal, to propose merging them. Only pairs the caller may merge: where they created either goal, or any pair for an admin. The same sentence typed differently always pairs; a reworded one pairs when the fast model is sure. Proposes only; nothing merges until a person approves it with PLAN_GOAL_MERGE.",
  annotations: {
    title: "Find Duplicate Plan Goals",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    dismissed: z
      .array(z.string().min(1).max(300))
      .max(MAX_DISMISSED_PLAN_GOAL_PAIRS)
      .default([])
      .describe("Keys of pairs the caller already said are not the same."),
  }),
  outputSchema: z.object({
    pairs: z
      .array(
        z.object({
          key: z.string().describe("The same for the pair in either order."),
          a: SimilarGoalSchema,
          b: SimilarGoalSchema,
        }),
      )
      .describe("The same sentence first, then the ones the model matched."),
  }),
  handler: async (input, ctx, call) => {
    const who = await caller(ctx);
    const goals = await ctx.storage.planGoals.list(
      who.orgId,
      who.userId,
      who.admin,
    );
    const { exact, candidates } = prefilterGoalPairs(goals, {
      skip: new Set(input.dismissed),
      allowed: (a, b) =>
        who.admin || a.created_by === who.userId || b.created_by === who.userId,
    });
    const asked = candidates.slice(
      0,
      Math.max(0, MAX_DUPLICATE_PAIRS - exact.length),
    );
    const same = await confirmSameGoals(
      ctx,
      who.orgId,
      asked.map(([a, b]) => ({ a: a.statement, b: b.statement })),
      DUPLICATES_TIMEOUT_MS,
      call?.signal,
    );
    return {
      pairs: [...exact, ...asked.filter((_, i) => same[i])]
        .slice(0, MAX_DUPLICATE_PAIRS)
        .map(([a, b]) => ({
          key: planGoalPairKey(a.id, b.id),
          a: SimilarGoalSchema.parse(a),
          b: SimilarGoalSchema.parse(b),
        })),
    };
  },
});

export const PLAN_GOAL_MERGE = defineTool({
  name: "PLAN_GOAL_MERGE",
  description:
    "Merge two of the organization's open Plan goals into one, after a person approved the merged sentence. The target keeps its id and takes the sentence; the source leaves the list, and whoever worked toward it and every business case started toward it move to the target. Case files keep the sentence they were written with. Only the creator of either goal, or an admin, may.",
  annotations: {
    title: "Merge Plan Goals",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    source_id: GoalIdSchema.describe("The goal that goes away."),
    target_id: GoalIdSchema.describe("The goal that stays."),
    statement: PlanGoalStatementSchema.describe(
      "The merged goal's sentence, as the person approved it.",
    ),
  }),
  outputSchema: z.object({ id: z.string() }),
  handler: async (input, ctx) => {
    const who = await caller(ctx);
    if (input.source_id === input.target_id) {
      throw new Error("Pick two different goals to merge.");
    }
    const [source, target] = await Promise.all([
      ctx.storage.planGoals.get(who.orgId, input.source_id),
      ctx.storage.planGoals.get(who.orgId, input.target_id),
    ]);
    if (!source?.open) throw new Error(`Goal not found: ${input.source_id}`);
    if (!target?.open) throw new Error(`Goal not found: ${input.target_id}`);
    if (
      !who.admin &&
      source.created_by !== who.userId &&
      target.created_by !== who.userId
    ) {
      throw new Error(
        "Only the person who created one of these goals, or an admin, can merge them.",
      );
    }
    const merged = await ctx.storage.planGoals.merge(
      who.orgId,
      input.source_id,
      input.target_id,
      input.statement,
      who.userId,
    );
    if (!merged) {
      throw new Error(
        "One of these goals was archived or merged in the meantime. Reload and try again.",
      );
    }
    emitPlanGoalsUpdated(who.orgId, input.target_id);
    return { id: input.target_id };
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
    "Pick the Plan goal the caller works toward; their Plan page opens on it. A goal merged into another picks the one it was merged into.",
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
    const goalId = await ctx.storage.planGoals.setActive(
      who.orgId,
      who.userId,
      input.goal_id,
    );
    if (!goalId) throw new Error(`Goal not found: ${input.goal_id}`);
    emitPlanGoalsUpdated(who.orgId, goalId);
    return { goal_id: goalId };
  },
});

export const PLAN_GOAL_CASE_RECORD = defineTool({
  name: "PLAN_GOAL_CASE_RECORD",
  description:
    "Record that a business case chat was started toward a Plan goal, or toward the goal it was merged into. The first record of a chat stands.",
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
    const goalId = await ctx.storage.planGoals.recordCase({
      organizationId: who.orgId,
      threadId: input.thread_id,
      goalId: input.goal_id,
      userId: who.userId,
    });
    if (!goalId) throw new Error(`Goal not found: ${input.goal_id}`);
    emitPlanGoalsUpdated(who.orgId, goalId);
    return { goal_id: goalId };
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
