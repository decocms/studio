/**
 * AUTOMATION_DELETE Tool
 *
 * Deletes an automation. Before deleting, disables all event triggers
 * on their MCP connections (best-effort).
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { configureTriggerOnMcp } from "./configure-trigger";

export const AUTOMATION_DELETE = defineTool({
  name: "AUTOMATION_DELETE",
  description:
    "Permanently delete an automation. Disables all event triggers on connected MCPs first.",
  annotations: {
    title: "Delete Automation",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    // Verify automation exists and belongs to org
    const existing = await ctx.storage.automations.findById(
      input.id,
      organization.id,
    );
    if (!existing) {
      throw new Error("Automation not found");
    }

    // Disable all event triggers on their MCP connections (best-effort)
    const triggers = await ctx.storage.automations.listTriggers(input.id);
    const eventTriggers = triggers.filter((t) => t.type === "event");

    await Promise.allSettled(
      eventTriggers.map(async (trigger) => {
        const result = await configureTriggerOnMcp(ctx, trigger, false);
        if (!result.success) {
          console.warn(
            `Failed to disable trigger ${trigger.id}: ${result.error}`,
          );
        }
      }),
    );

    // Delete the automation (cascading delete removes triggers)
    const { success } = await ctx.storage.automations.delete(
      input.id,
      organization.id,
    );

    return { success };
  },
});
