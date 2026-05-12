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
 *     pricing-known flag.
 *   - cacheStatus / cacheHitRatio       : derived stats.
 *   - renderCacheBox                    : the boxed `[decopilot:cache]`
 *     log used at end of every turn. Sections + footer parameterized
 *     so callers can show different context rows (parent shows
 *     org/vmcp/thread/user; subtask shows org/vmcp/tools).
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

// ─────────────────────────────────────────────────────────────────────
// Derived stats
// ─────────────────────────────────────────────────────────────────────

export type CacheStatus = "HIT ✅" | "WRITE 📝" | "MISS ❌";

export function cacheStatus(acc: CacheAccumulator): CacheStatus {
  if (acc.read > 0) return "HIT ✅";
  if (acc.write > 0) return "WRITE 📝";
  return "MISS ❌";
}

export function cacheHitRatio(acc: CacheAccumulator): number {
  // AI SDK v6's inputTokens already includes noCache + cacheRead +
  // cacheWrite (see convertAnthropicMessagesUsage / computeTokenUsage
  // in the provider adapters), so the denominator is just acc.input.
  return acc.input > 0 ? acc.read / acc.input : 0;
}

// ─────────────────────────────────────────────────────────────────────
// Boxed log renderer
// ─────────────────────────────────────────────────────────────────────

const BOX_WIDTH = 70; // characters between ║ and ║ inclusive
const INNER_WIDTH = BOX_WIDTH - 4; // 4 = "║  " + "║"
const RULE = `╠${"─".repeat(BOX_WIDTH - 2)}╣`;
const TOP = `╔${"═".repeat(BOX_WIDTH - 2)}╗`;
const MID = `╠${"═".repeat(BOX_WIDTH - 2)}╣`;
const BOTTOM = `╚${"═".repeat(BOX_WIDTH - 2)}╝`;

function row(label: string, value: string): string {
  // Two columns inside the box: 10-char label, then ": value", padded
  // to fit. Total inner width is INNER_WIDTH.
  const labelPart = label.padEnd(9);
  const text = `${labelPart}: ${value}`;
  return `║  ${text.padEnd(INNER_WIDTH)}║`;
}

export interface CacheBoxOptions {
  /** Bracketed tag for the header row, e.g. "decopilot:cache" or "decopilot:cache subtask". */
  tag: string;
  /** Cache status — derived via cacheStatus(acc). */
  status: CacheStatus;
  /**
   * Sections of [label, value] rows. Each section is separated by a
   * thin rule. By convention three sections: context, usage, cost.
   */
  sections: Array<Array<readonly [string, string]>>;
  /** Footer line emitted after the box. Useful for end-marker greps. */
  footer: string;
}

/**
 * Render the standard [decopilot:cache] box as a multi-line string.
 * Callers usually console.log the result.
 */
export function renderCacheBox(opts: CacheBoxOptions): string {
  const out: string[] = [];
  out.push("");
  out.push(TOP);
  // Header row needs the same formatting as a regular row but with the
  // tag + status as the value.
  const header = `[${opts.tag}] ${opts.status}`;
  out.push(`║  ${header.padEnd(INNER_WIDTH)}║`);
  out.push(MID);
  for (let s = 0; s < opts.sections.length; s++) {
    if (s > 0) out.push(RULE);
    for (const [label, value] of opts.sections[s]!) {
      out.push(row(label, value));
    }
  }
  out.push(BOTTOM);
  out.push(opts.footer);
  out.push("");
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────
// Cost / savings formatting
// ─────────────────────────────────────────────────────────────────────

/**
 * Render the per-section "cost / if uncached / saved" rows from an
 * accumulator. Common to both parent and subtask boxes.
 */
export function costSection(
  acc: CacheAccumulator,
): Array<readonly [string, string]> {
  if (acc.pricingUnknown) {
    return [
      ["cost", "(model unpriced — see pricing-table.json)"],
      ["if uncached", "(n/a)"],
      ["saved", "(n/a)"],
    ];
  }
  const savedAbs = acc.uncachedEquivalent - acc.cost;
  const savedPct =
    acc.uncachedEquivalent > 0
      ? `${((savedAbs / acc.uncachedEquivalent) * 100).toFixed(1)}%`
      : "0.0%";
  return [
    ["cost", `$${acc.cost.toFixed(6)}`],
    ["if uncached", `$${acc.uncachedEquivalent.toFixed(6)}`],
    ["saved", `$${savedAbs.toFixed(6)} (${savedPct})`],
  ];
}

/**
 * Render the "input/output/cache rd/cache wr/hit_ratio" usage section.
 */
export function usageSection(
  acc: CacheAccumulator,
  provider: string,
  modelId: string,
): Array<readonly [string, string]> {
  const pct = (cacheHitRatio(acc) * 100).toFixed(1);
  return [
    ["provider", provider],
    ["model", modelId],
    ["input", String(acc.input)],
    ["output", String(acc.output)],
    ["cache rd", String(acc.read)],
    ["cache wr", String(acc.write)],
    ["hit_ratio", `${pct}%`],
  ];
}
