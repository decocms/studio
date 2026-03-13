/**
 * AUTOMATION_CREATE Tool
 *
 * Creates a new automation with instructions, agent, and model configuration.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/mesh-context";

export const AUTOMATION_CREATE = defineTool({
  name: "AUTOMATION_CREATE",
  description:
    "Create a new automation with instructions, agent, and model configuration",
  annotations: {
    title: "Create Automation",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    name: z.string().min(1).max(255),
    agent: z.object({
      id: z.string(),
      mode: z.enum(["passthrough", "smart_tool_selection", "code_execution"]),
    }),
    messages: z.array(
      z.looseObject({
        id: z.string().optional(),
        role: z.enum(["user", "assistant", "system"]),
        parts: z.array(z.record(z.string(), z.unknown())),
        metadata: z.unknown().optional(),
      }),
    ),
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
      .loose(),
    temperature: z.number().default(0.5),
    active: z.boolean().default(false),
  }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    active: z.boolean(),
    created_at: z.string(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("Unable to determine user identity");
    }

    const automation = await ctx.storage.automations.create({
      organization_id: organization.id,
      created_by: userId,
      name: input.name,
      agent: JSON.stringify(input.agent),
      messages: JSON.stringify(input.messages),
      models: JSON.stringify(input.models),
      temperature: input.temperature,
      active: input.active,
    });

    return {
      id: automation.id,
      name: automation.name,
      active: automation.active,
      created_at: automation.created_at,
    };
  },
});
