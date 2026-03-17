/**
 * AUTOMATION_TRIGGER_ADD Tool
 *
 * Adds a trigger (cron or event) to an automation.
 * - Cron triggers: validated with croner, minimum 60s interval enforced
 * - Event triggers: fail-atomic — if TRIGGER_CONFIGURE call fails, trigger is not inserted
 */

import { Cron } from "croner";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { configureTriggerOnMcp } from "./configure-trigger";

export const AUTOMATION_TRIGGER_ADD = defineTool({
  name: "AUTOMATION_TRIGGER_ADD",
  description: "Add a cron or event-based trigger to an automation.",
  annotations: {
    title: "Add Trigger",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    automation_id: z.string(),
    type: z.enum(["cron", "event"]),
    cron_expression: z.string().optional(),
    connection_id: z.string().optional(),
    event_type: z.string().optional(),
    params: z.record(z.string(), z.string()).optional(),
  }),
  outputSchema: z.object({
    id: z.string(),
    automation_id: z.string(),
    type: z.enum(["cron", "event"]),
    created_at: z.string(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    // Validate automation exists and belongs to org
    const automation = await ctx.storage.automations.findById(
      input.automation_id,
      organization.id,
    );
    if (!automation) {
      throw new Error("Automation not found");
    }

    if (input.type === "cron") {
      if (!input.cron_expression) {
        throw new Error("cron_expression is required for cron triggers");
      }

      // Validate cron expression
      const cron = new Cron(input.cron_expression, { timezone: "UTC" });
      const runs = cron.nextRuns(2);
      if (runs.length >= 2 && runs[1]!.getTime() - runs[0]!.getTime() < 60000) {
        throw new Error(
          "Cron interval must be at least 60 seconds between runs",
        );
      }

      // Validate the expression has future runs
      if (!cron.nextRun()) {
        throw new Error("Cron expression has no future runs");
      }
    }

    if (input.type === "event") {
      if (!input.connection_id) {
        throw new Error("connection_id is required for event triggers");
      }
      if (!input.event_type) {
        throw new Error("event_type is required for event triggers");
      }

      // Validate connection belongs to this organization
      const connection = await ctx.storage.connections.findById(
        input.connection_id,
        organization.id,
      );
      if (!connection) {
        throw new Error("Connection not found");
      }

      // Build a temporary trigger object for configureTriggerOnMcp
      const tempTrigger = {
        id: "",
        automation_id: input.automation_id,
        type: "event" as const,
        cron_expression: null,
        connection_id: input.connection_id,
        event_type: input.event_type,
        params: input.params ? JSON.stringify(input.params) : null,
        last_run_at: null,
        created_at: "",
      };

      // Fail-atomic: if TRIGGER_CONFIGURE fails, do NOT insert trigger
      const result = await configureTriggerOnMcp(ctx, tempTrigger, true);
      if (!result.success) {
        throw new Error(
          `Failed to configure trigger on connection: ${result.error}`,
        );
      }
    }

    // Insert trigger record
    const trigger = await ctx.storage.automations.addTrigger({
      automation_id: input.automation_id,
      type: input.type,
      cron_expression: input.type === "cron" ? input.cron_expression : null,
      connection_id: input.type === "event" ? input.connection_id : null,
      event_type: input.type === "event" ? input.event_type : null,
      params: input.params ? JSON.stringify(input.params) : null,
    });

    return {
      id: trigger.id,
      automation_id: trigger.automation_id,
      type: trigger.type,
      created_at: trigger.created_at,
    };
  },
});
