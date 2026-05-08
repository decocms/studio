import { z } from "zod";

import type { ChatMode } from "./mode-config";

/**
 * Persisted run configuration schema.
 *
 * Stores only config fields needed to reconstruct a run.
 * Excludes: `messages` (in `thread_messages`), `abortSignal` (not serializable),
 * `organizationId`/`userId` (must come from auth context on resume).
 */

const PersistedModelInfoSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  capabilities: z
    .object({
      vision: z.boolean().optional(),
      text: z.boolean().optional(),
      tools: z.boolean().optional(),
      reasoning: z.boolean().optional(),
      file: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
  limits: z
    .object({
      contextWindow: z.number().optional(),
      maxOutputTokens: z.number().optional(),
    })
    .passthrough()
    .optional(),
  provider: z.string().nullish(),
});

/** Raw DB shape may include legacy `toolApprovalLevel: "plan"`. */
const PersistedRunConfigRawSchema = z.object({
  models: z.object({
    credentialId: z.string(),
    thinking: PersistedModelInfoSchema,
    coding: PersistedModelInfoSchema.optional(),
    fast: PersistedModelInfoSchema.optional(),
    image: PersistedModelInfoSchema.optional(),
    deepResearch: PersistedModelInfoSchema.optional(),
  }),
  agent: z.object({ id: z.string() }),
  temperature: z.number(),
  toolApprovalLevel: z.enum(["auto", "readonly", "plan"]).optional(),
  mode: z.enum(["default", "plan", "web-search", "gen-image"]).optional(),
  windowSize: z.number().optional(),
  triggerId: z.string().optional(),
});

export const PersistedRunConfigSchema = PersistedRunConfigRawSchema.transform(
  (raw) => {
    let mode: ChatMode = raw.mode ?? "default";
    let toolApprovalLevel: "auto" | "readonly" = "auto";

    if (raw.toolApprovalLevel === "plan") {
      mode = "plan";
      toolApprovalLevel = "readonly";
    } else if (raw.toolApprovalLevel === "readonly") {
      toolApprovalLevel = "readonly";
    } else if (raw.toolApprovalLevel === "auto") {
      toolApprovalLevel = "auto";
    }

    return {
      models: raw.models,
      agent: raw.agent,
      temperature: raw.temperature,
      toolApprovalLevel,
      mode,
      windowSize: raw.windowSize,
      triggerId: raw.triggerId,
    };
  },
);

export type PersistedRunConfig = z.output<typeof PersistedRunConfigSchema>;

type PersistedModelInfo = z.infer<typeof PersistedModelInfoSchema>;

/**
 * Reconstruct a full ModelInfo (with required `title`) from a persisted model.
 * Falls back to `id` when `title` was not stored.
 */
function toModelInfo(m: PersistedModelInfo) {
  return { ...m, title: m.title ?? m.id };
}

/**
 * Convert a persisted models config into the full `ModelsConfig` shape
 * expected by `StreamCoreInput`, filling in required fields that may
 * have been omitted at persistence time.
 */
export function toModelsConfig(models: PersistedRunConfig["models"]) {
  return {
    credentialId: models.credentialId,
    thinking: toModelInfo(models.thinking),
    ...(models.coding && { coding: toModelInfo(models.coding) }),
    ...(models.fast && { fast: toModelInfo(models.fast) }),
    ...(models.image && { image: toModelInfo(models.image) }),
    ...(models.deepResearch && {
      deepResearch: toModelInfo(models.deepResearch),
    }),
  };
}
