/**
 * Prompts Well-Known Binding
 *
 * Defines the interface for prompt providers.
 * Any MCP that implements this binding can expose prompts as a collection.
 *
 * This binding uses collection bindings for full CRUD operations.
 */

import { z } from "zod";
import type { Binder } from "../core/binder";
import {
  BaseCollectionEntitySchema,
  createCollectionBindings,
} from "./collections";

/**
 * Schema for prompt arguments that can be passed when getting a prompt
 */
export const PromptArgumentSchema = z.object({
  name: z.string().describe("Argument name"),
  description: z.string().optional().describe("Argument description"),
  required: z.boolean().optional().describe("Whether argument is required"),
});
export type PromptArgument = z.infer<typeof PromptArgumentSchema>;

/**
 * Schema for prompt icons for display in user interfaces
 */
export const PromptIconSchema = z.object({
  src: z.string().url().describe("Icon URL"),
  mimeType: z.string().optional().describe("Icon MIME type"),
  sizes: z.array(z.string()).optional().describe("Icon sizes"),
});
export type PromptIcon = z.infer<typeof PromptIconSchema>;

/**
 * Schema for content within a prompt message
 */
export const PromptMessageContentSchema = z.object({
  type: z.enum(["text", "image", "audio", "resource"]).describe("Content type"),
  text: z.string().optional().describe("Text content"),
  data: z.string().optional().describe("Base64-encoded data for image/audio"),
  mimeType: z
    .string()
    .optional()
    .describe("MIME type for image/audio/resource"),
  resource: z
    .object({
      uri: z.string().describe("Resource URI"),
      mimeType: z.string().optional().describe("Resource MIME type"),
      text: z.string().optional().describe("Resource text content"),
      blob: z.string().optional().describe("Base64-encoded resource blob"),
    })
    .optional()
    .describe("Embedded resource"),
});
export type PromptMessageContent = z.infer<typeof PromptMessageContentSchema>;

/**
 * Schema for a message in a prompt
 */
export const PromptMessageSchema = z.object({
  role: z.enum(["user", "assistant"]).describe("Message role"),
  content: PromptMessageContentSchema.describe("Message content"),
});
export type PromptMessage = z.infer<typeof PromptMessageSchema>;

/**
 * Full prompt entity schema extending base collection fields
 */
export const PromptSchema = BaseCollectionEntitySchema.extend({
  arguments: z
    .array(PromptArgumentSchema)
    .optional()
    .describe("Arguments that can be passed when getting this prompt"),
  icons: z
    .array(PromptIconSchema)
    .optional()
    .describe("Icons for display in user interfaces"),
  messages: z.array(PromptMessageSchema).describe("Prompt messages template"),
});
export type Prompt = z.infer<typeof PromptSchema>;

/**
 * PROMPT Collection Binding
 *
 * Collection bindings for prompts.
 * Provides full CRUD operations (LIST, GET, CREATE, UPDATE, DELETE) for prompts.
 */
export const PROMPTS_COLLECTION_BINDING = createCollectionBindings(
  "prompt",
  PromptSchema,
);

/**
 * PROMPTS Binding
 *
 * Required tools:
 * - PROMPT_LIST
 * - PROMPT_GET
 *
 * Optional tools:
 * - PROMPT_CREATE
 * - PROMPT_UPDATE
 * - PROMPT_DELETE
 */
export const PROMPTS_BINDING = [
  ...PROMPTS_COLLECTION_BINDING,
] as const satisfies Binder;
