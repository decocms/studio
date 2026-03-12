/**
 * AUTOMATION_TRIGGER_REMOVE Tool
 *
 * Removes a trigger from an automation. For event triggers,
 * disables the trigger on the MCP connection (best-effort).
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { configureTriggerOnMcp } from "./configure-trigger";

export const AUTOMATION_TRIGGER_REMOVE = defineTool({
  name: "AUTOMATION_TRIGGER_REMOVE",
  description:
    "Remove a trigger from an automation. Disables event triggers on their MCP connections.",
  annotations: {
    title: "Remove Trigger",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    trigger_id: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    // Load trigger
    const trigger = await ctx.storage.automations.findTriggerById(
      input.trigger_id,
    );
    if (!trigger) {
      throw new Error("Trigger not found");
    }

    // Verify parent automation belongs to org
    const automation = await ctx.storage.automations.findById(
      trigger.automation_id,
      organization.id,
    );
    if (!automation) {
      throw new Error("Automation not found");
    }

    // If event trigger, disable on MCP connection (best-effort)
    if (trigger.type === "event") {
      const result = await configureTriggerOnMcp(ctx, trigger, false);
      if (!result.success) {
        console.warn(
          `Failed to disable trigger ${trigger.id}: ${result.error}`,
        );
      }
    }

    // Delete trigger
    const { success } = await ctx.storage.automations.removeTrigger(
      trigger.id,
      trigger.automation_id,
    );

    return { success };
  },
});
