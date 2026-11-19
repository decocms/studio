/**
 * Plan built-ins
 *
 * An agent writes the store goal a person approved in a chat. A hosted agent reaches
 * Studio's own tools only through built-ins (sandbox-hosted runs get the whole
 * management catalog instead), so the writer is registered here too.
 *
 * Every agent gets it, unlike the agent-management built-ins: the tool is
 * member-writable, writes only `plan_objective`, and records the signed-in
 * person as its author, so it grants an agent nothing its user lacks. Only
 * orgs with the Plan page on get it; a failed settings read leaves it out
 * rather than failing the turn.
 */

import { tool, zodSchema, type ToolSet } from "ai";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import type { StudioContext } from "@/core/studio-context";
import { ORGANIZATION_PLAN_OBJECTIVE_SET } from "@/tools/organization/plan-objective-set";

export async function createPlanTools(
  ctx: StudioContext,
  organizationId: string,
): Promise<ToolSet> {
  try {
    const settings = await ctx.storage.organizationSettings.get(organizationId);
    if (!orgFlagEnabled(settings?.flags, "plan_page_enabled")) return {};
  } catch {
    return {};
  }
  return {
    ORGANIZATION_PLAN_OBJECTIVE_SET: tool({
      description: ORGANIZATION_PLAN_OBJECTIVE_SET.description,
      inputSchema: zodSchema(ORGANIZATION_PLAN_OBJECTIVE_SET.inputSchema),
      execute: (input) => ORGANIZATION_PLAN_OBJECTIVE_SET.execute(input, ctx),
    }),
  };
}
