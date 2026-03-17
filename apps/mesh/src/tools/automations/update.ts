/**
 * AUTOMATION_UPDATE Tool
 *
 * Updates automation fields. When the active state changes, configures
 * event triggers on their MCP connections accordingly.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { configureTriggerOnMcp } from "./configure-trigger";

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
    agent: z
      .object({
        id: z.string(),
      })
      .optional(),
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
        credentialId: z.string(),
        thinking: z.object({
          id: z.string(),
          capabilities: z
            .object({
              vision: z.boolean().optional(),
              text: z.boolean().optional(),
              tools: z.boolean().optional(),
            })
            .optional(),
          provider: z
            .enum([
              "openai",
              "anthropic",
              "google",
              "xai",
              "deepseek",
              "openrouter",
              "openai-compatible",
            ])
            .optional()
            .nullable(),
          limits: z
            .object({
              contextWindow: z.number().optional(),
              maxOutputTokens: z.number().optional(),
            })
            .optional(),
        }),
        coding: z.object({ id: z.string() }).optional(),
        fast: z.object({ id: z.string() }).optional(),
      })
      .loose()
      .optional(),
    temperature: z.number().optional(),
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
    if (input.agent !== undefined)
      updateData.agent = JSON.stringify(input.agent);
    if (input.messages !== undefined) {
      const normalizedMessages =
        typeof input.messages === "string"
          ? [
              {
                role: "user" as const,
                parts: [{ type: "text", text: input.messages }],
              },
            ]
          : input.messages;
      updateData.messages = JSON.stringify(normalizedMessages);
    }
    if (input.models !== undefined)
      updateData.models = JSON.stringify(input.models);
    if (input.temperature !== undefined)
      updateData.temperature = input.temperature;
    const automation = await ctx.storage.automations.update(
      input.id,
      organization.id,
      updateData,
    );

    // When active state changes, configure event triggers
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
    }

    return {
      id: automation.id,
      name: automation.name,
      active: automation.active,
      updated_at: automation.updated_at,
    };
  },
});
