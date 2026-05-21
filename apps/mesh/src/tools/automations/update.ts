/**
 * AUTOMATION_UPDATE Tool
 *
 * Updates automation fields. When the active state changes, configures
 * event triggers on their MCP connections accordingly.
 */

import { z } from "zod";
import { syncAutomationActiveChanged } from "../../automations/dbos-sync";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { ChatTierSchema } from "../organization/schema";
import { configureTriggerOnMcp } from "./configure-trigger";
import { normalizeMessages } from "./normalize-messages";

export const AUTOMATION_UPDATE = defineTool({
  name: "AUTOMATION_UPDATE",
  description:
    "Update an automation's config. Toggling active state reconfigures event triggers on MCPs.",
  annotations: {
    title: "Update Automation",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
    name: z.string().min(1).max(255).optional(),
    active: z.boolean().optional(),
    messages: z
      .union([
        z.string(),
        z.array(
          z.looseObject({
            id: z.string().optional(),
            role: z.enum(["user", "assistant", "system"]),
            parts: z.array(z.record(z.string(), z.unknown())),
            metadata: z.unknown().optional(),
          }),
        ),
      ])
      .optional(),
    models: z
      .object({
        tier: ChatTierSchema,
      })
      .optional(),
    temperature: z.number().optional(),
    // Tool-call updates. The automation's kind is immutable (create a new
    // one if you need a different kind), but the fixed args / target tool
    // can be edited on a kind='tool_call' automation.
    connection_id: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.string(), z.unknown()).optional(),
  }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    active: z.boolean(),
    updated_at: z.string(),
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

    // Build update payload
    const updateData: Record<string, unknown> = {};
    if (input.name !== undefined) updateData.name = input.name;
    if (input.active !== undefined) updateData.active = input.active;
    if (input.messages !== undefined) {
      const normalizedMessages = normalizeMessages(input.messages);
      updateData.messages = JSON.stringify(normalizedMessages);
    }
    if (input.models !== undefined)
      updateData.models = JSON.stringify(input.models);
    if (input.temperature !== undefined)
      updateData.temperature = input.temperature;
    if (
      input.connection_id !== undefined ||
      input.tool_name !== undefined ||
      input.tool_input !== undefined
    ) {
      if (existing.kind !== "tool_call") {
        throw new Error(
          "connection_id / tool_name / tool_input can only be set on kind='tool_call' automations",
        );
      }
      if (input.connection_id !== undefined) {
        // Cross-org isolation. Workflow re-checks at fire time; this is
        // the earlier rejection. Empty string is allowed because the UI
        // creates blank tool_call automations and lets the user fill in
        // the connection on the detail screen.
        if (input.connection_id !== "") {
          const exists = await ctx.storage.connections.findById(
            input.connection_id,
            organization.id,
          );
          if (!exists) {
            throw new Error(
              `connection ${input.connection_id} not found in this organization`,
            );
          }
        }
        updateData.connection_id = input.connection_id;
      }
      if (input.tool_name !== undefined) updateData.tool_name = input.tool_name;
      if (input.tool_input !== undefined)
        updateData.tool_input = JSON.stringify(input.tool_input);
    }
    const automation = await ctx.storage.automations.update(
      input.id,
      organization.id,
      updateData,
    );

    // When active state changes, configure event triggers AND pause/resume
    // the DBOS schedules tied to cron triggers — DBOS schedules fire even
    // when the workflow body would short-circuit on active=false, so we
    // pause to avoid wasting workflow records.
    if (input.active !== undefined && input.active !== existing.active) {
      const triggers = await ctx.storage.automations.listTriggers(
        automation.id,
      );
      const eventTriggers = triggers.filter((t) => t.type === "event");

      await Promise.allSettled(
        eventTriggers.map(async (trigger) => {
          const result = await configureTriggerOnMcp(
            ctx,
            trigger,
            input.active!,
          );
          if (!result.success) {
            console.warn(
              `Failed to configure trigger ${trigger.id}: ${result.error}`,
            );
          }
        }),
      );

      await syncAutomationActiveChanged(triggers, input.active);
    }

    return {
      id: automation.id,
      name: automation.name,
      active: automation.active,
      updated_at: automation.updated_at,
    };
  },
});
