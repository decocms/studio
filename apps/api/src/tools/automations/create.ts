/**
 * AUTOMATION_CREATE Tool
 *
 * Creates a new automation that runs an agent thread on trigger fire.
 */

import { z } from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { ChatTierSchema } from "@decocms/shared/organization/schema";
import { normalizeMessages } from "./normalize-messages";

export const AUTOMATION_CREATE = defineTool({
  name: "AUTOMATION_CREATE",
  description:
    "Create an automation that runs an agent thread on trigger fire. Requires virtual_mcp_id + messages.",
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
        tier: ChatTierSchema,
        // Optional specific-model override. When both are set, the fire path
        // pins this concrete model instead of resolving the org tier preset.
        modelId: z.string().optional(),
        credentialId: z.string().optional(),
      })
      .loose()
      .default({ tier: "smart" }),
    // Allowlist of model-facing tool names the run is restricted to.
    // null/omitted = all of the bound agent's tools (default behavior).
    tools: z.array(z.string()).nullable().optional(),
    // Parent agent-loop step cap. null/omitted = platform default
    // (PARENT_STEP_LIMIT). Raise it for automations that legitimately need
    // more reasoning/tool steps before stopping.
    maxAgentSteps: z.number().int().min(1).max(100).nullable().optional(),
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
      tools:
        input.tools === undefined || input.tools === null
          ? null
          : JSON.stringify(input.tools),
      max_agent_steps: input.maxAgentSteps ?? null,
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
