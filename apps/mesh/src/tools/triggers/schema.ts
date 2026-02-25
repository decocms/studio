import { z } from "zod";

export const TriggerTypeSchema = z.enum(["cron", "event"]);
export const TriggerActionTypeSchema = z.enum(["tool_call", "agent_prompt"]);

export const CreateTriggerInputSchema = z.object({
  title: z
    .string()
    .optional()
    .nullable()
    .describe("Optional name for the trigger"),
  triggerType: TriggerTypeSchema.describe(
    "Type of trigger: cron schedule or event listener",
  ),
  cronExpression: z
    .string()
    .optional()
    .nullable()
    .describe("Cron expression (required when triggerType=cron)"),
  eventType: z
    .string()
    .optional()
    .nullable()
    .describe("Event type to listen for (required when triggerType=event)"),
  eventFilter: z
    .string()
    .optional()
    .nullable()
    .describe("JSONPath filter on event data"),
  actionType: TriggerActionTypeSchema.describe(
    "Action to execute: tool_call or agent_prompt",
  ),
  connectionId: z
    .string()
    .optional()
    .nullable()
    .describe("Connection ID (required when actionType=tool_call)"),
  toolName: z
    .string()
    .optional()
    .nullable()
    .describe("Tool name (required when actionType=tool_call)"),
  toolArguments: z
    .string()
    .optional()
    .nullable()
    .describe("JSON arguments for tool call"),
  agentId: z
    .string()
    .optional()
    .nullable()
    .describe("Virtual MCP ID (required when actionType=agent_prompt)"),
  agentPrompt: z
    .string()
    .optional()
    .nullable()
    .describe("Prompt text (required when actionType=agent_prompt)"),
});

export const TriggerOutputSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  title: z.string().nullable(),
  enabled: z.boolean(),
  triggerType: TriggerTypeSchema,
  cronExpression: z.string().nullable(),
  eventType: z.string().nullable(),
  eventFilter: z.string().nullable(),
  actionType: TriggerActionTypeSchema,
  connectionId: z.string().nullable(),
  toolName: z.string().nullable(),
  toolArguments: z.string().nullable(),
  agentId: z.string().nullable(),
  agentPrompt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: z.string().nullable(),
  lastRunError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
});

export const TriggerListOutputSchema = z.object({
  triggers: z.array(TriggerOutputSchema),
});

export const UpdateTriggerInputSchema = z.object({
  id: z.string().describe("Trigger ID to update"),
  title: z.string().optional().nullable(),
  enabled: z.boolean().optional(),
  triggerType: TriggerTypeSchema.optional(),
  cronExpression: z.string().optional().nullable(),
  eventType: z.string().optional().nullable(),
  eventFilter: z.string().optional().nullable(),
  actionType: TriggerActionTypeSchema.optional(),
  connectionId: z.string().optional().nullable(),
  toolName: z.string().optional().nullable(),
  toolArguments: z.string().optional().nullable(),
  agentId: z.string().optional().nullable(),
  agentPrompt: z.string().optional().nullable(),
});

export const TriggerIdInputSchema = z.object({
  id: z.string().describe("Trigger ID"),
});

export const DeleteTriggerOutputSchema = z.object({
  success: z.boolean(),
});
