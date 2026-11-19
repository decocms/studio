/**
 * ORGANIZATION_PLAN_OBJECTIVE_DECIDE — ask Jev which goal the store should
 * work on first, from its last 28 days in the data lake or its connections.
 *
 * Read-only: it returns the goal and the numbers behind it. The web words the
 * goal in the person's language and saves it with
 * ORGANIZATION_PLAN_OBJECTIVE_SET, so a server never writes translated text.
 */

import { z } from "zod";
import {
  orgFlagEnabled,
  PlanGoalSchema,
  StoreSnapshotSchema,
} from "@decocms/shared/organization/schema";
import { defineTool } from "../../core/define-tool";
import { openJev } from "../../core/evaluate-decisions";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { acceptGoalDecision, buildGoalDecision } from "./plan-goal-decision";
import { loadConnectionSnapshot } from "./plan-goal-connections";
import { loadStoreSnapshot } from "./plan-goal-snapshot";

export const ORGANIZATION_PLAN_OBJECTIVE_DECIDE = defineTool({
  name: "ORGANIZATION_PLAN_OBJECTIVE_DECIDE",
  description:
    "Ask Jev, a decision model, which goal the store should work on first, from its last 28 days of traffic, funnel and orders, read from the data lake or, without it, from the store's connections (VTEX, GA4, BigQuery and others). Returns the goal and the numbers behind it, or why it could not decide. Does not save the goal.",
  annotations: {
    title: "Decide Store Goal",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    decision: z
      .object({
        goal: PlanGoalSchema,
        probability: z.number().min(0).max(1),
        snapshot: StoreSnapshotSchema,
      })
      .nullable(),
    reason: z
      .enum(["no_data", "unavailable", "uncertain"])
      .optional()
      .describe(
        "Why there is no decision: no_data when neither the lake nor the connections back two goals, unavailable when Jev cannot be reached, uncertain when its answer is a guess.",
      ),
  }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);
    const settings = await ctx.storage.organizationSettings.get(org.id);
    if (!orgFlagEnabled(settings?.flags, "plan_page_enabled")) {
      throw new Error("The Plan page is not enabled for this organization");
    }

    const now = new Date();
    const fromLake = await loadStoreSnapshot(org.id, now);
    const lakeQuestion = fromLake ? buildGoalDecision(fromLake) : null;
    const snapshot = lakeQuestion
      ? fromLake
      : await loadConnectionSnapshot(ctx, org.id, now);
    const question =
      lakeQuestion ?? (snapshot ? buildGoalDecision(snapshot) : null);
    if (!snapshot || !question)
      return { decision: null, reason: "no_data" as const };

    const jev = await openJev(ctx, org.id);
    if (!jev) return { decision: null, reason: "unavailable" as const };
    try {
      const { answers } = await jev.evaluate(question);
      const accepted = acceptGoalDecision(answers, question.questions);
      return accepted
        ? { decision: { ...accepted, snapshot } }
        : { decision: null, reason: "uncertain" as const };
    } catch (error) {
      console.warn(
        "[plan-goal] Jev decision failed",
        error instanceof Error ? error.message : "unknown error",
      );
      return { decision: null, reason: "unavailable" as const };
    }
  },
});
