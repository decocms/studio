import { z } from "zod";

// Local copy (not shared from organization/schema) so observation tools don't
// depend on the org-settings module.
const ModelSlotSchema = z
  .object({
    keyId: z.string(),
    modelId: z.string(),
    title: z.string().optional(),
  })
  .nullable();

/**
 * A single observer — an agent that observes idle threads, with its own scope,
 * model, and watermark. `id` is stable (the thread_observations key) and is
 * assigned server-side when an observer is first saved.
 */
const ObserverConfigSchema = z.object({
  id: z
    .string()
    .default("")
    .describe(
      "Stable observer id (the per-thread watermark key). Assigned server-side; clients may leave empty when adding a new observer.",
    ),
  agentId: z
    .string()
    .describe(
      "Virtual MCP (agent) id that observes idle threads. Empty string = unconfigured (skipped).",
    ),
  scopeMode: z
    .enum(["all", "only"])
    .default("all")
    .describe(
      "Which agents to observe: 'all' observes every agent except scopeAgentIds; 'only' observes just scopeAgentIds.",
    ),
  scopeAgentIds: z
    .array(z.string())
    .default([])
    .describe(
      "Agent ids the scope applies to — excluded when scopeMode is 'all', the allowlist when scopeMode is 'only'.",
    ),
  model: ModelSlotSchema.default(null).describe(
    "Specific model the observer runs with (exact credential + model). When null, falls back to the org's fast tier.",
  ),
  configuredAt: z
    .string()
    .nullable()
    .default(null)
    .describe(
      "ISO timestamp this observer was (re)enabled; the sweep only observes threads active at/after it. Set automatically server-side — observation is forward-only, never a history backfill.",
    ),
});

/**
 * Observational agents config — a per-org list of observers (N supported). An
 * empty list disables observation.
 */
export const ObservationalConfigSchema = z.object({
  observers: z
    .array(ObserverConfigSchema)
    .default([])
    .describe("The org's observers. Empty list disables observation."),
});

export type ObservationalConfig = z.infer<typeof ObservationalConfigSchema>;
