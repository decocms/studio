/**
 * AUTOMATION_GET Tool
 *
 * Gets a single automation by ID, including its full configuration and triggers.
 */

import {
  BoardTransitionFromSchema,
  triggerFrom,
} from "../../automations/board-column-transition";
import { AutomationTriggerTypeSchema } from "./trigger-schema";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

export const AUTOMATION_GET = defineTool({
  name: "AUTOMATION_GET",
  description: "Get an automation's full configuration and triggers by ID.",
  annotations: {
    title: "Get Automation",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
  }),
  outputSchema: z.object({
    automation: z
      .object({
        id: z.string(),
        name: z.string(),
        active: z.boolean(),
        created_by: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
        virtual_mcp_id: z.string(),
        messages: z.unknown(),
        models: z.unknown(),
        tools: z.array(z.string()).nullable(),
        maxAgentSteps: z.number().nullable(),
        temperature: z.number(),
        triggers: z.array(
          z.object({
            id: z.string(),
            type: AutomationTriggerTypeSchema,
            cron_expression: z.string().nullable(),
            connection_id: z.string().nullable(),
            event_type: z.string().nullable(),
            params: z.unknown().nullable(),
            last_run_at: z.string().nullable(),
            api_key_id: z.string().nullable(),
            column_key: z.string().nullable(),
            from: BoardTransitionFromSchema.nullable(),
            created_at: z.string(),
          }),
        ),
      })
      .nullable(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const automation = await ctx.storage.automations.findById(
      input.id,
      organization.id,
    );

    if (!automation) {
      return { automation: null };
    }

    const triggers = await ctx.storage.automations.listTriggers(automation.id);

    return {
      automation: {
        id: automation.id,
        name: automation.name,
        active: automation.active,
        created_by: automation.created_by,
        created_at: automation.created_at,
        updated_at: automation.updated_at,
        virtual_mcp_id: automation.virtual_mcp_id,
        messages: JSON.parse(automation.messages),
        models: JSON.parse(automation.models),
        tools: automation.tools ? JSON.parse(automation.tools) : null,
        maxAgentSteps: automation.max_agent_steps,
        temperature: automation.temperature,
        triggers: triggers.map((t) => ({
          id: t.id,
          type: t.type,
          cron_expression: t.cron_expression,
          connection_id: t.connection_id,
          event_type: t.event_type,
          params: t.params ? JSON.parse(t.params) : null,
          last_run_at: t.last_run_at,
          api_key_id: t.api_key_id,
          column_key: t.column_key,
          from: t.type === "board_column_transition" ? triggerFrom(t) : null,
          created_at: t.created_at,
        })),
      },
    };
  },
});
