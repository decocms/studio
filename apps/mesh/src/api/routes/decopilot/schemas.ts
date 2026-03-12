/**
 * Decopilot Request Schemas
 *
 * Zod validation schemas for Decopilot API requests.
 */

import { z } from "zod";
import { DEFAULT_WINDOW_SIZE } from "./constants";

const UIMessageSchema = z.looseObject({
  id: z.string().optional(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(z.record(z.string(), z.unknown())),
  metadata: z.unknown().optional(),
});

const MemoryConfigSchema = z.object({
  windowSize: z.number().default(DEFAULT_WINDOW_SIZE),
  thread_id: z.string(),
});

const ProviderEnum = z.enum([
  "openai",
  "anthropic",
  "google",
  "xai",
  "deepseek",
  "openrouter",
  "openai-compatible",
]);

const ProviderSchema = ProviderEnum.optional().nullable();

const ModelInfoSchema = z.object({
  id: z.string(),
  // Optional for backward compat with legacy clients that don't send title
  title: z.string().optional(),
  capabilities: z
    .object({
      vision: z.boolean().optional(),
      text: z.boolean().optional(),
      tools: z.boolean().optional(),
    })
    .optional(),
  limits: z
    .object({
      contextWindow: z.number().optional(),
      maxOutputTokens: z.number().optional(),
    })
    .optional(),
});

const ThinkingModelSchema = ModelInfoSchema.extend({
  provider: ProviderSchema,
});

const ModelsSchema = z
  .object({
    // New AI-provider-key path
    credentialId: z.string().optional(),
    // Legacy MCP-connection path (kept for backward compat until UI ships)
    connectionId: z.string().optional(),
    thinking: ThinkingModelSchema.describe(
      "Backbone model for the agentic loop",
    ),
    coding: ModelInfoSchema.optional().describe("Good coding model"),
    fast: ModelInfoSchema.optional().describe("Cheap model for simple tasks"),
  })
  .loose()
  .refine((d) => !!(d.credentialId || d.connectionId), {
    message: "Either credentialId or connectionId is required",
    path: ["credentialId"],
  });

export const StreamRequestSchema = z.object({
  messages: z
    .array(UIMessageSchema)
    .min(1)
    .refine((msgs) => msgs.filter((m) => m.role !== "system").length === 1, {
      message: "Expected exactly one non-system message",
    }),
  memory: MemoryConfigSchema.optional(),
  models: ModelsSchema,
  agent: z
    .object({
      id: z.string(),
      mode: z.enum(["passthrough", "smart_tool_selection", "code_execution"]),
    })
    .loose(),
  stream: z.boolean().optional(),
  temperature: z.number().default(0.5),
  thread_id: z.string().optional(),
  toolApprovalLevel: z.enum(["none", "readonly", "yolo"]).default("none"),
});

export type StreamRequest = z.infer<typeof StreamRequestSchema>;
