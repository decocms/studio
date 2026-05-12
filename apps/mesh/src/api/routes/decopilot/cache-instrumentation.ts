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
 *     cumulative cache_read / cache_write / input / output token
 *     counts. Read by OTel-attr emission in stream-core.
 *
 * Cost is intentionally NOT tracked here: we trust whatever the upstream
 * provider authoritatively reports (OpenRouter exposes a `cost` field;
 * direct Anthropic / OpenAI / Gemini don't, and we'd rather show tokens
 * in the UI than guess.
 */

import type { ToolSet } from "ai";

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
          providerOptions: deepMerge(existingProviderOptions, {
            anthropic: { cacheControl: EPHEMERAL_5M },
          }),
        } as unknown as ToolSet[string],
      ];
    }),
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

// Recursive merge for plain-object trees (providerOptions is JSON-ish).
// Non-plain values (arrays, primitives) are replaced, not merged.
function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const existing = out[k];
    out[k] =
      isPlainObject(existing) && isPlainObject(v) ? deepMerge(existing, v) : v;
  }
  return out;
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
}

export function emptyCacheAccumulator(): CacheAccumulator {
  return { read: 0, write: 0, input: 0, output: 0 };
}

/**
 * Update `acc` with one step's worth of usage. Reads cache tokens from
 * AI SDK's provider-agnostic usage.inputTokenDetails (populated
 * identically by anthropic / openai / google / openrouter adapters).
 *
 * Mutates `acc` in place.
 */
export function addCacheStep(
  acc: CacheAccumulator,
  usage: CacheStepUsage | undefined,
): void {
  if (!usage) return;
  acc.read += usage.inputTokenDetails?.cacheReadTokens ?? 0;
  acc.write += usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  acc.input += usage.inputTokens ?? 0;
  acc.output += usage.outputTokens ?? 0;
}
