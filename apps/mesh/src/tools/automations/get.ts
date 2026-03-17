/**
 * AUTOMATION_GET Tool
 *
 * Gets a single automation by ID, including its full configuration and triggers.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";

export const AUTOMATION_GET = defineTool({
  name: "AUTOMATION_GET",
  description:
    "Get an automation's full configuration, triggers, and run history by ID.",
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
        agent: z.unknown(),
        messages: z.unknown(),
        models: z.unknown(),
        temperature: z.number(),
        triggers: z.array(
          z.object({
            id: z.string(),
            type: z.enum(["cron", "event"]),
            cron_expression: z.string().nullable(),
            connection_id: z.string().nullable(),
            event_type: z.string().nullable(),
            params: z.unknown().nullable(),
            last_run_at: z.string().nullable(),
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
        agent: JSON.parse(automation.agent),
        messages: JSON.parse(automation.messages),
        models: JSON.parse(automation.models),
        temperature: automation.temperature,
        triggers: triggers.map((t) => ({
          id: t.id,
          type: t.type,
          cron_expression: t.cron_expression,
          connection_id: t.connection_id,
          event_type: t.event_type,
          params: t.params ? JSON.parse(t.params) : null,
          last_run_at: t.last_run_at,
          created_at: t.created_at,
        })),
      },
    };
  },
});
