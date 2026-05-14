/**
 * Cumulative usage tracker for streamText loops.
 *
 * Aggregates token counts (input/output/total), cache read/write tokens,
 * and provider-reported cost across `streamText` steps. Used by the
 * decopilot harness (`runDecopilotStream`) and by the CLI harnesses
 * (claude-code, codex) so all three emit consistent cumulative usage
 * in `messageMetadata` chunks.
 *
 * Replicates the inline accumulator pattern that lived in pre-refactor
 * `stream-core.ts` (lines 1411–1571 of commit `2073a39b8`):
 *   - `stepAccumulatedUsage` (running sum of inputTokens / outputTokens /
 *     totalTokens)
 *   - `stepCacheAcc` (cache token breakdown from
 *     `usage.inputTokenDetails`)
 *   - `stepAccumulatedCost` (OpenRouter `usage.cost` field; absent for
 *     direct Anthropic / OpenAI / Gemini)
 *   - `lastProviderMetadata` (last `finish-step.providerMetadata` so the
 *     final `finish` chunk can sanitize it)
 *
 * The accumulator exposes two emission helpers that produce the exact
 * `messageMetadata.usage` shape the frontend expects (see
 * `packages/mesh-sdk/src/lib/usage.ts:UsageData`):
 *   - `buildStepUsage()` for `finish-step` chunks (cumulative through
 *     the current step, no `reasoningTokens` or sanitized provider
 *     metadata).
 *   - `buildFinalUsage({ totalUsage, providerKey })` for `finish` chunks
 *     (final cumulative state with `reasoningTokens` + sanitized
 *     provider metadata, with the abort-fallback rule that uses the
 *     step accumulator when the SDK reports zeroed totals on abort).
 *
 * Cost is intentionally only contributed by providers that
 * authoritatively report it (OpenRouter today). For Anthropic-direct,
 * OpenAI, and Gemini the field is absent and `stepAccumulatedCost`
 * stays 0 — the UI then shows tokens instead of a dollar amount.
 */

import { sanitizeProviderMetadata } from "@decocms/mesh-sdk";
import type { LanguageModelUsage } from "ai";
import { addCacheStep } from "../api/routes/decopilot/cache-instrumentation";

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

/** Per-step usage shape we consume. Compatible with the AI SDK's
 *  `LanguageModelUsage` (which adds optional `reasoningTokens`). */
export interface StepUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

/** The cumulative-usage shape we emit in `messageMetadata.usage` on
 *  `finish-step` chunks. */
export interface StepUsageEmission {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  inputTokenDetails: {
    cacheReadTokens: number;
    cacheWriteTokens: number;
    noCacheTokens: number;
  };
  providerMetadata?: {
    openrouter: { usage: { cost: number } };
  };
}

/** The cumulative-usage shape we emit on the final `finish` chunk —
 *  adds `reasoningTokens` (read from the SDK's `totalUsage`) and a
 *  sanitized full `providerMetadata` block. */
export interface FinalUsageEmission {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number | undefined;
  totalTokens: number;
  cachedInputTokens: number;
  inputTokenDetails: {
    cacheReadTokens: number;
    cacheWriteTokens: number;
    noCacheTokens: number;
  };
  providerMetadata?: Record<string, unknown>;
}

export interface UsageAccumulator {
  /** Add one step's worth of usage + provider metadata. Mutates state
   *  in place. Returns the new cumulative totals. */
  addStep(
    usage: StepUsage | undefined,
    providerMetadata: Record<string, unknown> | undefined,
  ): {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };

  /** Build the `messageMetadata.usage` payload for a `finish-step`
   *  chunk — cumulative totals + cache breakdown + (when nonzero)
   *  OpenRouter cost. Pure read; does not mutate. */
  buildStepUsage(): StepUsageEmission;

  /** Build the `messageMetadata.usage` payload for the final `finish`
   *  chunk. Applies the abort-fallback rule (use the cumulative step
   *  totals when the SDK's `totalUsage` is zeroed) and merges
   *  accumulated cost into the sanitized provider metadata.
   *
   *  Returns `undefined` if there's no usage at all (no steps received
   *  any tokens AND the SDK's totalUsage is absent/zero) — caller
   *  should omit the `usage` key entirely in that case. */
  buildFinalUsage(args: {
    totalUsage: LanguageModelUsage | null | undefined;
    /** The provider key (e.g. "anthropic", "openrouter", "google") so
     *  `reasoning_details` can be stripped from that provider's slice.
     *  Pass `null`/`undefined` to skip the strip. */
    providerKey?: string | null;
    /** Fallback `providerMetadata` if no step ever reported one
     *  (e.g., a 0-step stream where the `finish` chunk carries the
     *  only provider metadata). Mirrors the pre-refactor stream-core
     *  fallback at line 1487: `lastProviderMetadata ??
     *  part.providerMetadata`. */
    fallbackProviderMetadata?: Record<string, unknown>;
  }): FinalUsageEmission | undefined;

  /** Read accumulated cumulative totals. */
  totalTokens(): {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };

  /** Read accumulated cache breakdown. */
  cacheTotals(): { read: number; write: number; input: number };

  /** Read accumulated cost. */
  cost(): number;
}

// ─────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────

export function createUsageAccumulator(): UsageAccumulator {
  let totals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  const cache = { read: 0, write: 0, input: 0 };
  let accCost = 0;
  let lastProviderMetadata: Record<string, unknown> | undefined;

  function readOpenRouterCost(
    providerMetadata: Record<string, unknown> | undefined,
  ): number {
    return (
      (
        providerMetadata?.openrouter as
          | { usage?: { cost?: number } }
          | undefined
      )?.usage?.cost ?? 0
    );
  }

  return {
    addStep(usage, providerMetadata) {
      if (providerMetadata !== undefined) {
        lastProviderMetadata = providerMetadata;
      }
      totals = {
        inputTokens: totals.inputTokens + (usage?.inputTokens ?? 0),
        outputTokens: totals.outputTokens + (usage?.outputTokens ?? 0),
        totalTokens: totals.totalTokens + (usage?.totalTokens ?? 0),
      };
      // Reuse the shared cache-instrumentation accumulator so cache
      // token counting stays identical to what the OTel attrs / abort
      // path read.
      addCacheStep(cache, usage);
      // Cost: only providers that authoritatively report it (OpenRouter
      // today) contribute.
      accCost += readOpenRouterCost(providerMetadata);
      return { ...totals };
    },

    buildStepUsage(): StepUsageEmission {
      return {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        totalTokens: totals.totalTokens,
        // Forward AI-SDK normalized cache token details so the
        // frontend's tooltip can read them. Without this our explicit
        // usage shape replaces the SDK's default and drops these fields.
        cachedInputTokens: cache.read,
        inputTokenDetails: {
          cacheReadTokens: cache.read,
          cacheWriteTokens: cache.write,
          noCacheTokens: totals.inputTokens - cache.read - cache.write,
        },
        ...(accCost > 0 && {
          providerMetadata: {
            openrouter: { usage: { cost: accCost } },
          },
        }),
      };
    },

    buildFinalUsage({ totalUsage, providerKey, fallbackProviderMetadata }) {
      const providerMeta = lastProviderMetadata ?? fallbackProviderMetadata;
      // Merge accumulated per-step cost into the final provider metadata.
      const finalProviderMeta =
        accCost > 0 && providerMeta
          ? {
              ...providerMeta,
              openrouter: {
                ...((providerMeta.openrouter as Record<string, unknown>) ?? {}),
                usage: {
                  ...(((providerMeta.openrouter as Record<string, unknown>)
                    ?.usage as Record<string, unknown>) ?? {}),
                  cost: accCost,
                },
              },
            }
          : providerMeta;

      // On abort the SDK emits finish with totalUsage = 0. Fall back to
      // the cumulative step totals so we don't overwrite the per-step
      // metadata that was already sent to the client.
      const effectiveUsage =
        totalUsage &&
        ((totalUsage.inputTokens ?? 0) > 0 ||
          (totalUsage.outputTokens ?? 0) > 0)
          ? totalUsage
          : totals.totalTokens > 0
            ? totals
            : totalUsage;

      if (!effectiveUsage) return undefined;

      return {
        inputTokens: effectiveUsage.inputTokens ?? 0,
        outputTokens: effectiveUsage.outputTokens ?? 0,
        reasoningTokens:
          (totalUsage as { reasoningTokens?: number } | null | undefined)
            ?.reasoningTokens ?? undefined,
        totalTokens: effectiveUsage.totalTokens ?? 0,
        cachedInputTokens: cache.read,
        inputTokenDetails: {
          cacheReadTokens: cache.read,
          cacheWriteTokens: cache.write,
          noCacheTokens:
            (effectiveUsage.inputTokens ?? 0) - cache.read - cache.write,
        },
        providerMetadata: sanitizeProviderMetadata(
          providerKey && finalProviderMeta
            ? {
                ...finalProviderMeta,
                [providerKey]: {
                  ...((finalProviderMeta[providerKey] as object) ?? {}),
                  reasoning_details: undefined,
                },
              }
            : finalProviderMeta,
        ),
      };
    },

    totalTokens() {
      return { ...totals };
    },
    cacheTotals() {
      return { ...cache };
    },
    cost() {
      return accCost;
    },
  };
}
