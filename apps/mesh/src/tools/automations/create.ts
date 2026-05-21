/**
 * AUTOMATION_CREATE Tool
 *
 * Creates a new automation. Two kinds are supported:
 *   - kind="agent" (default): traditional automation that runs an agent
 *     thread on trigger fire.
 *   - kind="tool_call": deterministic automation that invokes a fixed MCP
 *     tool with fixed arguments on trigger fire — no LLM, no agent.
 *
 * TODO(tool-call-validation): for kind="tool_call" we should fetch the
 * connection's tool list and validate `tool_input` against the tool's
 * declared inputSchema at create time so misconfigured automations fail
 * loudly here rather than at fire time.
 */

import { z } from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/mesh-context";
import { ChatTierSchema } from "../organization/schema";
import { normalizeMessages } from "./normalize-messages";

export const AUTOMATION_CREATE = defineTool({
  name: "AUTOMATION_CREATE",
  description:
    "Create an automation. kind='agent' runs an agent thread (requires virtual_mcp_id + messages); kind='tool_call' invokes a fixed MCP tool deterministically (requires connection_id + tool_name + tool_input).",
  annotations: {
    title: "Create Automation",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    name: z.string().min(1).max(255),
    kind: z.enum(["agent", "tool_call"]).default("agent"),
    // Agent fields — required when kind='agent'.
    virtual_mcp_id: z.string().optional(),
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
      .loose()
      .default({ tier: "smart" }),
    temperature: z.number().default(0.5),
    // Tool-call fields — required when kind='tool_call'.
    connection_id: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.record(z.string(), z.unknown()).optional(),
    active: z.boolean().default(true),
  }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    active: z.boolean(),
    kind: z.enum(["agent", "tool_call"]),
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

    if (input.kind === "agent") {
      if (!input.virtual_mcp_id) {
        throw new Error("virtual_mcp_id is required for kind='agent'");
      }
      if (input.messages === undefined) {
        throw new Error("messages is required for kind='agent'");
      }
    }
    // kind='tool_call' is intentionally tolerant at create time: the UI
    // creates a blank tool-call automation and lets the user fill in
    // connection_id / tool_name / tool_input on the detail screen
    // (matching the agent flow's "new → edit" pattern). The DB CHECK
    // only enforces NOT NULL on connection_id + tool_name, so we store
    // empty strings here and rely on the workflow's invokeFixedToolStep
    // to refuse to fire until those values are populated.
    if (input.kind === "tool_call" && input.connection_id) {
      // Cross-org isolation: reject ids that don't resolve in this org.
      // The workflow scopes by org at fire time too; this is the
      // earlier, friendlier rejection.
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

    // For tool_call kind, messages/models/temperature are vestigial — the
    // workflow branch never reads them. Store inert defaults so the
    // NOT NULL columns are satisfied without surfacing them in the API.
    const normalizedMessages =
      input.kind === "agent" && input.messages !== undefined
        ? normalizeMessages(input.messages)
        : [];

    const automation = await ctx.storage.automations.create({
      organization_id: organization.id,
      created_by: userId,
      name: input.name,
      kind: input.kind,
      messages: JSON.stringify(normalizedMessages),
      models: JSON.stringify(input.models),
      temperature: input.temperature,
      active: input.active,
      virtual_mcp_id: input.kind === "agent" ? input.virtual_mcp_id : null,
      connection_id:
        input.kind === "tool_call" ? (input.connection_id ?? "") : null,
      tool_name: input.kind === "tool_call" ? (input.tool_name ?? "") : null,
      tool_input:
        input.kind === "tool_call"
          ? JSON.stringify(input.tool_input ?? {})
          : null,
    });

    posthog.capture({
      distinctId: userId,
      event: "automation_created",
      groups: { organization: organization.id },
      properties: {
        organization_id: organization.id,
        automation_id: automation.id,
        kind: automation.kind,
        virtual_mcp_id: input.virtual_mcp_id,
        connection_id: input.connection_id,
        tool_name: input.tool_name,
        active: automation.active,
        tier: input.models.tier,
      },
    });

    return {
      id: automation.id,
      name: automation.name,
      active: automation.active,
      kind: automation.kind,
      created_at: automation.created_at,
    };
  },
});
