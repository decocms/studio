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
  "deco",
  "claude-code",
  "codex",
]);

const ProviderSchema = ProviderEnum.optional().nullable();

const ModelInfoSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  capabilities: z
    .object({
      vision: z.boolean().optional(),
      text: z.boolean().optional(),
      tools: z.boolean().optional(),
      reasoning: z.boolean().optional(),
    })
    .optional(),
  provider: ProviderSchema,
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
    credentialId: z.string(),
    thinking: ThinkingModelSchema.describe(
      "Backbone model for the agentic loop",
    ),
    coding: ModelInfoSchema.optional().describe("Good coding model"),
    fast: ModelInfoSchema.optional().describe("Cheap model for simple tasks"),
    image: ModelInfoSchema.optional().describe("Image generation model"),
    deepResearch: ModelInfoSchema.optional().describe(
      "Deep research model (e.g. Perplexity Sonar) for web_search tool",
    ),
  })
  .loose();

export const StreamRequestSchema = z.object({
  messages: z
    .array(UIMessageSchema)
    .min(1)
    .refine((msgs) => msgs.filter((m) => m.role !== "system").length === 1, {
      message: "Expected exactly one non-system message",
    }),
  memory: MemoryConfigSchema.optional(),
  models: ModelsSchema.optional(),
  agent: z
    .object({
      id: z.string(),
    })
    .loose(),
  stream: z.boolean().optional(),
  temperature: z.number().default(0.5),
  thread_id: z.string().optional(),
  /**
   * Git branch to pin the thread to on first-message creation. Only honored
   * when the thread doesn't exist yet; existing threads keep their branch.
   */
  branch: z.string().nullish(),
  toolApprovalLevel: z.enum(["auto", "readonly"]).default("auto"),
  mode: z
    .enum(["default", "plan", "web-search", "gen-image"])
    .default("default"),
});

export type StreamRequest = z.infer<typeof StreamRequestSchema>;
