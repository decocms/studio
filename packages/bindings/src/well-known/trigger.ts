/**
 * Trigger Well-Known Binding
 *
 * Defines the interface for connections that can emit triggers.
 * Any MCP that implements this binding can list available triggers
 * and configure them for automations.
 *
 * This binding includes:
 * - TRIGGER_LIST: List available trigger definitions
 * - TRIGGER_CONFIGURE: Configure a trigger with parameters
 */

import { z } from "zod";
import { bindingClient, type ToolBinder } from "../core/binder";

// ============================================================================
// Trigger List Schemas
// ============================================================================

/**
 * Schema for a trigger parameter definition
 */
export const TriggerParamSchema = z.object({
  type: z.literal("string"),
  enum: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export type TriggerParam = z.infer<typeof TriggerParamSchema>;

/**
 * Schema for a trigger definition
 */
export const TriggerDefinitionSchema = z.object({
  type: z.string(),
  description: z.string(),
  paramsSchema: z.record(z.string(), TriggerParamSchema),
});

export type TriggerDefinition = z.infer<typeof TriggerDefinitionSchema>;

/**
 * TRIGGER_LIST Input Schema
 */
export const TriggerListInputSchema = z.object({});

export type TriggerListInput = z.infer<typeof TriggerListInputSchema>;

/**
 * TRIGGER_LIST Output Schema
 */
export const TriggerListOutputSchema = z.object({
  triggers: z.array(TriggerDefinitionSchema),
});

export type TriggerListOutput = z.infer<typeof TriggerListOutputSchema>;

// ============================================================================
// Trigger Configure Schemas
// ============================================================================

/**
 * TRIGGER_CONFIGURE Input Schema
 *
 * Input for configuring a trigger with parameters.
 */
export const TriggerConfigureInputSchema = z.object({
  type: z.string(),
  params: z.record(z.string(), z.string()),
  enabled: z.boolean(),
});

export type TriggerConfigureInput = z.infer<typeof TriggerConfigureInputSchema>;

/**
 * TRIGGER_CONFIGURE Output Schema
 */
export const TriggerConfigureOutputSchema = z.object({
  success: z.boolean(),
});

export type TriggerConfigureOutput = z.infer<
  typeof TriggerConfigureOutputSchema
>;

// ============================================================================
// Trigger Binding
// ============================================================================

/**
 * Trigger Binding
 *
 * Defines the interface for connections that can emit triggers.
 * Implementations must provide TRIGGER_LIST and TRIGGER_CONFIGURE tools.
 *
 * Required tools:
 * - TRIGGER_LIST: List available trigger definitions with their parameter schemas
 * - TRIGGER_CONFIGURE: Configure a trigger with specific parameters
 */
export const TRIGGER_BINDING = [
  {
    name: "TRIGGER_LIST" as const,
    inputSchema: TriggerListInputSchema,
    outputSchema: TriggerListOutputSchema,
  },
  {
    name: "TRIGGER_CONFIGURE" as const,
    inputSchema: TriggerConfigureInputSchema,
    outputSchema: TriggerConfigureOutputSchema,
  },
] satisfies ToolBinder[];

/**
 * Trigger Binding Client
 *
 * Use this to create a client for interacting with triggers.
 *
 * @example
 * ```typescript
 * import { TriggerBinding } from "@decocms/bindings/trigger";
 *
 * // For a connection
 * const client = TriggerBinding.forConnection(connection);
 *
 * // List available triggers
 * const { triggers } = await client.TRIGGER_LIST({});
 *
 * // Configure a trigger
 * await client.TRIGGER_CONFIGURE({
 *   type: "cron",
 *   params: { schedule: "0 9 * * 1" },
 *   enabled: true,
 * });
 * ```
 */
export const TriggerBinding = bindingClient(TRIGGER_BINDING);

/**
 * Type helper for the Trigger binding client
 */
export type TriggerBindingClient = ReturnType<
  typeof TriggerBinding.forConnection
>;
