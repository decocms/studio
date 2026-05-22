/**
 * AUTOMATION_TRIGGER_REMOVE Tool
 *
 * Removes a trigger from an automation. For event triggers,
 * disables the trigger on the MCP connection (best-effort).
 */

import { z } from "zod";
import { syncTriggerDeleted } from "../../automations/dbos-sync";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { configureTriggerOnMcp } from "./configure-trigger";

export const AUTOMATION_TRIGGER_REMOVE = defineTool({
  name: "AUTOMATION_TRIGGER_REMOVE",
  description:
    "Remove a trigger from an automation. Disables associated event listeners on MCPs.",
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
      const result = await configureTriggerOnMcp(
        ctx,
        trigger,
        false,
        ctx.storage.triggerCallbackTokens,
      );
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

    if (trigger.type === "cron") {
      await syncTriggerDeleted(trigger.id);
    }

    // Webhook triggers own a Better Auth API key — revoke it so a leaked
    // token can't keep firing the now-deleted webhook. Best-effort: if the
    // delete fails the trigger row is already gone, so the URL is dead.
    if (trigger.type === "webhook" && trigger.api_key_id) {
      try {
        await ctx.boundAuth.apiKey.delete(trigger.api_key_id);
      } catch (err) {
        console.warn(
          `[trigger-remove] failed to delete api key ${trigger.api_key_id} for trigger ${trigger.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return { success };
  },
});
