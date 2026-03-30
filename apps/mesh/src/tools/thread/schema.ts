/**
 * Thread Schema Definitions
 *
 * Zod schemas for Thread and ThreadMessage entities, following the collection pattern.
 */

import { z } from "zod";

import { THREAD_STATUSES } from "@/storage/types";

// ============================================================================
// Thread Message Schema
// ============================================================================

/**
 * Note: The `parts` field uses a permissive schema because ThreadMessage.parts
 * comes from AI SDK's UIMessage type, which includes many part types
 * (text, reasoning, tool-call, tool-result, dynamic-tool, file, etc.)
 * that evolve with the SDK. We rely on TypeScript types from storage/types.ts
 * for compile-time safety.
 */
export const ThreadMessageEntitySchema = z.object({
  id: z.string().describe("Unique message ID"),
  thread_id: z.string().describe("ID of the parent thread"),
  metadata: z.unknown().optional().describe("Optional message metadata"),
  parts: z
    .array(z.record(z.string(), z.unknown()))
    .describe("Message content parts (AI SDK UIMessagePart format)"),
  role: z.enum(["user", "assistant", "system"]).describe("Message role"),
  created_at: z.string().datetime().describe("Timestamp of creation"),
  updated_at: z.string().datetime().describe("Timestamp of last update"),
});

export type ThreadMessageEntity = z.infer<typeof ThreadMessageEntitySchema>;

// ============================================================================
// Thread Schema
// ============================================================================

export const ThreadEntitySchema = z.object({
  id: z.string().describe("Unique thread ID"),
  organization_id: z.string().describe("Organization this thread belongs to"),
  title: z.string().describe("Thread title"),
  description: z.string().nullable().describe("Thread description"),
  created_at: z.string().datetime().describe("Timestamp of creation"),
  updated_at: z.string().datetime().describe("Timestamp of last update"),
  hidden: z.boolean().optional().describe("Whether the thread is hidden"),
  status: z
    .enum([...THREAD_STATUSES, "expired"])
    .describe(
      "Thread execution status. 'expired' is virtual -- computed at read time for stale in_progress threads",
    ),
  created_by: z.string().describe("User ID who created the thread"),
  updated_by: z
    .string()
    .nullable()
    .describe("User ID who last updated the thread"),
  virtual_mcp_id: z
    .string()
    .optional()
    .describe("Virtual MCP (agent) this thread was initiated with"),
  // Typed as a loose record to stay compatible with the Kysely storage type
  // (Thread.run_config: Record<string, unknown> | null). Callers that need the
  // typed shape should parse with PersistedRunConfigSchema from run-config.ts.
  run_config: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe("Persisted run configuration (contains agent and model info)"),
});

export type ThreadEntity = z.infer<typeof ThreadEntitySchema>;

// ============================================================================
// Create/Update Schemas
// ============================================================================

export const ThreadCreateDataSchema = z.object({
  id: z.string().optional().describe("Optional custom ID for the thread"),
  title: z.string().describe("Thread title"),
  description: z.string().nullish().describe("Thread description"),
});

export type ThreadCreateData = z.infer<typeof ThreadCreateDataSchema>;

export const ThreadUpdateDataSchema = z.object({
  title: z.string().optional().describe("New thread title"),
  description: z.string().nullish().describe("New thread description"),
  hidden: z.boolean().optional().describe("Whether the thread is hidden"),
  status: z
    .enum(["requires_action", "failed", "in_progress", "completed"])
    .optional()
    .describe(
      "New thread status (user-set override). 'expired' is a computed virtual status and cannot be set directly.",
    ),
});

export type ThreadUpdateData = z.infer<typeof ThreadUpdateDataSchema>;
