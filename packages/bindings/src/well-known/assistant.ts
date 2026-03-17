/**
 * Assistants Well-Known Binding
 *
 * Defines the interface for AI assistant providers.
 * Any MCP that implements this binding can provide configurable AI assistants
 * with a system prompt and runtime configuration (virtual MCP + model).
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
 * Assistant entity schema for AI assistants
 * Extends BaseCollectionEntitySchema with assistant-specific fields
 * Base schema already includes: id, title, created_at, updated_at, created_by, updated_by
 */
export const AssistantSchema = BaseCollectionEntitySchema.extend({
  /**
   * Assistant avatar.
   * Can be a regular URL or a data URI.
   */
  avatar: z
    .string()
    .describe("URL or data URI to the assistant's avatar image"),

  /**
   * System prompt that defines the assistant's behavior.
   */
  system_prompt: z
    .string()
    .describe("System prompt that defines the assistant's behavior"),

  /**
   * Selected virtual MCP (agent) for this assistant.
   * This virtual MCP determines which MCP tools are exposed to chat.
   */
  virtual_mcp_id: z
    .string()
    .describe("Virtual MCP ID to use for this assistant"),

  /**
   * Selected model for this assistant (model id + the connection where it lives).
   * This allows the UI/runtime to call the correct model provider connection.
   */
  model: z
    .object({
      id: z.string().describe("Model ID"),
      connectionId: z
        .string()
        .describe("Connection ID that provides the model"),
    })
    .describe("Selected model reference for this assistant"),
});

/**
 * ASSISTANT Collection Binding
 *
 * Collection bindings for assistants.
 * Provides full CRUD operations (LIST, GET, CREATE, UPDATE, DELETE) for AI assistants.
 */
export const ASSISTANTS_COLLECTION_BINDING = createCollectionBindings(
  "assistant",
  AssistantSchema,
);

/**
 * ASSISTANTS Binding
 *
 * Defines the interface for AI assistant providers.
 * Any MCP that implements this binding can provide configurable AI assistants.
 *
 * Required tools:
 * - ASSISTANT_LIST: List available AI assistants with their configurations
 * - ASSISTANT_GET: Get a single assistant by ID (includes system_prompt, virtual_mcp_id, model)
 *
 * Optional tools:
 * - ASSISTANT_CREATE: Create a new assistant
 * - ASSISTANT_UPDATE: Update an existing assistant
 * - ASSISTANT_DELETE: Delete an assistant
 */
export const ASSISTANTS_BINDING = [
  ...ASSISTANTS_COLLECTION_BINDING,
] as const satisfies Binder;
