/**
 * AUTOMATION_LIST Tool
 *
 * Lists automations for the current organization, including trigger counts.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";

export const AUTOMATION_LIST = defineTool({
  name: "AUTOMATION_LIST",
  description:
    "List automations with their status, triggers, and configuration.",
  annotations: {
    title: "List Automations",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    virtual_mcp_id: z.string().optional().nullable(),
  }),
  outputSchema: z.object({
    automations: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        active: z.boolean(),
        created_by: z.string(),
        created_at: z.string(),
        trigger_count: z.number(),
        nearest_next_run_at: z.string().nullable(),
        kind: z.enum(["agent", "tool_call"]),
        virtual_mcp_id: z.string().nullable(),
        connection_id: z.string().nullable(),
        tool_name: z.string().nullable(),
      }),
    ),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const automations = await ctx.storage.automations.listWithTriggerCounts(
      organization.id,
      input.virtual_mcp_id,
    );

    const results = automations.map((automation) => ({
      id: automation.id,
      name: automation.name,
      active: automation.active,
      created_by: automation.created_by,
      created_at: automation.created_at,
      trigger_count: automation.trigger_count,
      nearest_next_run_at: automation.nearest_next_run_at,
      kind: automation.kind,
      virtual_mcp_id: automation.virtual_mcp_id,
      connection_id: automation.connection_id,
      tool_name: automation.tool_name,
    }));

    return { automations: results };
  },
});
