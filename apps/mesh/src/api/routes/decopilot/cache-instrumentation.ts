/**
 * Shared cache-instrumentation primitives used by both the parent
 * decopilot loop (stream-core.ts) and the subtask path
 * (built-in-tools/subtask.ts):
 *
 *   - OPENROUTER_CACHE_PROVIDER_OPTIONS : the providerOptions value to
 *     attach top-level on every streamText call for OpenRouter cache.
 *   - withCachedToolPrefix              : sort a ToolSet by name and
 *     mark the last tool with anthropic.cacheControl so all tool
 *     definitions become a cached prefix (separate from the
 *     system/messages cache).
 *   - CacheAccumulator + addCacheStep   : turn-scoped state holder for
 *     cumulative cache_read/write/input/output/cost/uncached, plus
 *     pricing-known flag. Read by OTel-attr emission in stream-core.
 */

import type { ToolSet } from "ai";
import { computeCost } from "./pricing";

// ─────────────────────────────────────────────────────────────────────
// providerOptions constants
// ─────────────────────────────────────────────────────────────────────

const EPHEMERAL_5M = {
  type: "ephemeral" as const,
  ttl: "5m" as const,
};

// Inferred shape is JSON-serializable, so it satisfies streamText's
// SharedV3ProviderOptions (Record<string, Record<string, JSONValue>>).
export const OPENROUTER_CACHE_PROVIDER_OPTIONS = {
  openrouter: { cache_control: { type: "ephemeral", ttl: "5m" } },
};

// ─────────────────────────────────────────────────────────────────────
// Tool-cache marker
// ─────────────────────────────────────────────────────────────────────

/**
 * Sort the ToolSet by tool name (so the request body is byte-stable
 * across calls) and attach anthropic.cacheControl on the LAST tool so
 * all tool definitions become a cached prefix in Anthropic's separate
 * tool-cache layer. Caching tools this way does NOT consume any of the
 * 4 system/messages cache breakpoints.
 *
 * Returns the same ToolSet shape; safe to pass straight to streamText.
 */
export function withCachedToolPrefix(tools: ToolSet): ToolSet {
  const sorted = Object.entries(tools).sort(([a], [b]) => a.localeCompare(b));
  const lastIdx = sorted.length - 1;
  return Object.fromEntries(
    sorted.map(([name, t], i) => {
      if (i !== lastIdx) return [name, t];
      const tAsRecord = t as unknown as Record<string, unknown>;
      const existingProviderOptions =
        (tAsRecord.providerOptions as Record<string, unknown> | undefined) ??
        {};
      return [
        name,
        {
          ...tAsRecord,
          providerOptions: {
            ...existingProviderOptions,
            anthropic: { cacheControl: EPHEMERAL_5M },
          },
        } as unknown as ToolSet[string],
      ];
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────
// Accumulator
// ─────────────────────────────────────────────────────────────────────

export interface CacheStepUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export interface CacheAccumulator {
  read: number;
  write: number;
  input: number;
  output: number;
  cost: number;
  uncachedEquivalent: number;
  pricingUnknown: boolean;
}

export function emptyCacheAccumulator(): CacheAccumulator {
  return {
    read: 0,
    write: 0,
    input: 0,
    output: 0,
    cost: 0,
    uncachedEquivalent: 0,
    pricingUnknown: false,
  };
}

/**
 * Update `acc` with one step's worth of usage. Reads cache tokens from
 * AI SDK's provider-agnostic usage.inputTokenDetails. Calls computeCost
 * for the per-step cost; if the model isn't in the pricing table the
 * pricingUnknown flag flips and cost stays 0.
 *
 * Mutates `acc` in place.
 */
export function addCacheStep(
  acc: CacheAccumulator,
  usage: CacheStepUsage | undefined,
  providerId: string | undefined,
  modelId: string,
): void {
  if (!usage) return;
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  acc.read += cacheRead;
  acc.write += cacheWrite;
  acc.input += input;
  acc.output += output;
  const breakdown = computeCost(providerId, modelId, {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  });
  if (breakdown) {
    acc.cost += breakdown.total;
    acc.uncachedEquivalent += breakdown.uncachedEquivalent;
  } else {
    acc.pricingUnknown = true;
  }
}
