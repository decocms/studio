/**
 * Plan built-ins
 *
 * An agent writes the goal a person approved in a chat. A hosted agent reaches
 * Studio's own tools only through built-ins (sandbox-hosted runs get the whole
 * management catalog instead), so the writers are registered here too.
 *
 * Every agent gets them, unlike the agent-management built-ins: the tools are
 * member-writable, write only Plan goals, and record the signed-in person as
 * the author, so they grant an agent nothing its user lacks. Only orgs with
 * the Plan page on get them. With Plan goals on, the agent reads the org's
 * goals, adds one and picks one; otherwise it writes the single store goal.
 * A failed settings read leaves them out rather than failing the turn.
 */

import { tool, zodSchema, type ToolSet } from "ai";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import type { StudioContext } from "@/core/studio-context";
import { ORGANIZATION_PLAN_OBJECTIVE_SET } from "@/tools/organization/plan-objective-set";
import {
  PLAN_ACTIVE_GOAL_SET,
  PLAN_GOAL_CREATE,
  PLAN_GOAL_LIST,
} from "@/tools/plan-goals";

export async function createPlanTools(
  ctx: StudioContext,
  organizationId: string,
): Promise<ToolSet> {
  let goals: boolean;
  try {
    const settings = await ctx.storage.organizationSettings.get(organizationId);
    if (!orgFlagEnabled(settings?.flags, "plan_page_enabled")) return {};
    goals = orgFlagEnabled(settings?.flags, "plan_goals_enabled");
  } catch {
    return {};
  }
  if (!goals) {
    return {
      ORGANIZATION_PLAN_OBJECTIVE_SET: tool({
        description: ORGANIZATION_PLAN_OBJECTIVE_SET.description,
        inputSchema: zodSchema(ORGANIZATION_PLAN_OBJECTIVE_SET.inputSchema),
        execute: (input) => ORGANIZATION_PLAN_OBJECTIVE_SET.execute(input, ctx),
      }),
    };
  }
  return {
    PLAN_GOAL_LIST: tool({
      description: PLAN_GOAL_LIST.description,
      inputSchema: zodSchema(PLAN_GOAL_LIST.inputSchema),
      execute: (input) => PLAN_GOAL_LIST.execute(input, ctx),
    }),
    PLAN_GOAL_CREATE: tool({
      description: PLAN_GOAL_CREATE.description,
      inputSchema: zodSchema(PLAN_GOAL_CREATE.inputSchema),
      execute: (input) => PLAN_GOAL_CREATE.execute(input, ctx),
    }),
    PLAN_ACTIVE_GOAL_SET: tool({
      description: PLAN_ACTIVE_GOAL_SET.description,
      inputSchema: zodSchema(PLAN_ACTIVE_GOAL_SET.inputSchema),
      execute: (input) => PLAN_ACTIVE_GOAL_SET.execute(input, ctx),
    }),
  };
}
