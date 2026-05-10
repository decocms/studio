/**
 * AUTOMATION_CREATE Tool
 *
 * Creates a new automation with instructions, agent, and model configuration.
 */

import { z } from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/mesh-context";
import { normalizeMessages } from "./normalize-messages";

export const AUTOMATION_CREATE = defineTool({
  name: "AUTOMATION_CREATE",
  description:
    "Create an automation with instructions, agent, and model config. Triggers can be added separately.",
  annotations: {
    title: "Create Automation",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    name: z.string().min(1).max(255),
    virtual_mcp_id: z.string(),
    messages: z.union([
      z.string(),
      z.array(
        z.looseObject({
          id: z.string().optional(),
          role: z.enum(["user", "assistant", "system"]),
          parts: z.array(z.record(z.string(), z.unknown())),
          metadata: z.unknown().optional(),
        }),
      ),
    ]),
    models: z
      .object({
        tier: z.enum(["fast", "smart", "thinking"]),
      })
      .loose()
      .default({ tier: "smart" }),
    temperature: z.number().default(0.5),
    active: z.boolean().default(true),
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

    const normalizedMessages = normalizeMessages(input.messages);

    const automation = await ctx.storage.automations.create({
      organization_id: organization.id,
      created_by: userId,
      name: input.name,
      messages: JSON.stringify(normalizedMessages),
      models: JSON.stringify(input.models),
      temperature: input.temperature,
      active: input.active,
      virtual_mcp_id: input.virtual_mcp_id,
    });

    posthog.capture({
      distinctId: userId,
      event: "automation_created",
      groups: { organization: organization.id },
      properties: {
        organization_id: organization.id,
        automation_id: automation.id,
        virtual_mcp_id: input.virtual_mcp_id,
        active: automation.active,
        tier: input.models.tier,
      },
    });

    return {
      id: automation.id,
      name: automation.name,
      active: automation.active,
      created_at: automation.created_at,
    };
  },
});
