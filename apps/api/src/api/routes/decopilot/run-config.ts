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

/**
 * Image and deepResearch tiers can resolve to a different credential than the
 * chat tier. Pre-fix runs persisted without these per-tool credentialIds — on
 * resume, the dispatch falls back to the chat credential, matching the
 * legacy single-provider behavior.
 */
const PersistedToolModelInfoSchema = PersistedModelInfoSchema.extend({
  credentialId: z.string().optional(),
});

/** Raw DB shape may include legacy `toolApprovalLevel: "plan"`. */
const PersistedRunConfigRawSchema = z.object({
  // Legacy rows may carry a `coding` slot; the non-strict object drops it
  // on parse (the slot was removed — D11).
  models: z.object({
    credentialId: z.string(),
    thinking: PersistedModelInfoSchema,
    fast: PersistedModelInfoSchema.optional(),
    image: PersistedToolModelInfoSchema.optional(),
    webSearch: PersistedToolModelInfoSchema.optional(),
    deepResearch: PersistedToolModelInfoSchema.optional(),
  }),
  // The default non-strict object drops legacy request-selected `agent` data.
  // The thread's virtual_mcp_id is the only runtime authority.
  temperature: z.number(),
  toolApprovalLevel: z.enum(["auto", "readonly", "plan"]).optional(),
  mode: z
    .enum(["default", "plan", "web-search", "deep-research", "gen-image"])
    .optional(),
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
      temperature: raw.temperature,
      toolApprovalLevel,
      mode,
      windowSize: raw.windowSize,
      triggerId: raw.triggerId,
    };
  },
);
