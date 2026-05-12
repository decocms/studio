/**
 * Model pricing for decopilot cost computation.
 *
 * Loads pricing-table.json and exposes a single function, `computeCost`,
 * that takes a (provider, modelId, usage) triple and returns a number of
 * USD or null when the model isn't priced in the table.
 *
 * Cache-discount aware: a request that hits cache for 90% of input tokens
 * pays the cached-read rate on those tokens and the standard input rate on
 * the rest. Cache writes (Anthropic only) are billed at the cache-write
 * rate (typically 125% of the base input rate).
 */

import pricingTable from "./pricing-table.json" with { type: "json" };

export interface ModelPricing {
  /** USD per 1,000,000 input tokens (uncached). */
  input: number;
  /** USD per 1,000,000 output tokens. */
  output: number;
  /** USD per 1,000,000 cache-read input tokens. Optional: models without cache caching omit this. */
  cachedRead?: number;
  /** USD per 1,000,000 cache-write input tokens (Anthropic only). */
  cacheWrite?: number;
}

export interface TokenUsage {
  /** Total input tokens (uncached + cache-read + cache-write). */
  inputTokens: number;
  /** Output tokens. */
  outputTokens: number;
  /** Cache-read input tokens (subset of inputTokens). */
  cacheReadTokens: number;
  /** Cache-write input tokens (Anthropic-only; subset of inputTokens). */
  cacheWriteTokens: number;
}

export interface CostBreakdown {
  /** Total cost in USD. */
  total: number;
  /** Cost of uncached input tokens. */
  inputCost: number;
  /** Cost of cache-read input tokens. */
  cacheReadCost: number;
  /** Cost of cache-write input tokens. */
  cacheWriteCost: number;
  /** Cost of output tokens. */
  outputCost: number;
  /** What the cost would have been with zero cache hits. */
  uncachedEquivalent: number;
  /** Pricing record actually used (after normalization). */
  pricing: ModelPricing;
  /** Canonical key used to look up pricing (after normalization). */
  resolvedKey: string;
}

// Aliases — map common date-stamped or vendor-prefixed model IDs to the
// canonical key in pricing-table.json. The matching pipeline is:
//   1. Strip a `provider/` prefix (OpenRouter style).
//   2. Look up in the provider's section directly.
//   3. Try the alias map.
const ALIAS_MAP: Record<string, string> = {
  // Anthropic — date-stamped IDs
  "claude-3-5-sonnet-20241022": "claude-3-5-sonnet",
  "claude-3-5-sonnet-20240620": "claude-3-5-sonnet",
  "claude-3-5-haiku-20241022": "claude-3-5-haiku",
  "claude-3-opus-20240229": "claude-3-opus",
  "claude-3-sonnet-20240229": "claude-3-sonnet",
  "claude-3-haiku-20240307": "claude-3-haiku",
  "claude-opus-4-7-20251201": "claude-opus-4-7",
  "claude-sonnet-4-6-20251024": "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  // Anthropic — dotted variants
  "claude-opus-4.7": "claude-opus-4-7",
  "claude-opus-4.6": "claude-opus-4-6",
  "claude-opus-4.5": "claude-opus-4-5",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4.5": "claude-sonnet-4-5",
  "claude-haiku-4.5": "claude-haiku-4-5",
  // OpenAI — date-stamped
  "gpt-4o-2024-11-20": "gpt-4o",
  "gpt-4o-2024-08-06": "gpt-4o",
  "gpt-4o-mini-2024-07-18": "gpt-4o-mini",
  // Google — version variants
  "gemini-2.5-pro-002": "gemini-2.5-pro",
  "gemini-2.5-flash-002": "gemini-2.5-flash",
  "gemini-1.5-pro-002": "gemini-1.5-pro",
  "gemini-1.5-flash-002": "gemini-1.5-flash",
};

// Normalize provider names — some places report "claude-code" or
// "openai-compat" etc., which we want to resolve back to one of the three
// canonical pricing namespaces.
const PROVIDER_ALIASES: Record<string, string> = {
  anthropic: "anthropic",
  claude: "anthropic",
  openai: "openai",
  google: "google",
  gemini: "google",
  vertex: "google",
  "google-vertex": "google",
};

type Table = Record<string, Record<string, ModelPricing>>;

const TABLE = pricingTable as unknown as Table;

/**
 * Look up the pricing record for a given (provider, modelId) pair.
 * Returns null if the model isn't priced in the table.
 *
 * Resolution order:
 *   1. Strip any `<provider>/` prefix from the modelId (OpenRouter style).
 *   2. Canonicalize the provider via PROVIDER_ALIASES.
 *   3. Try modelId exactly in the provider's section.
 *   4. Try modelId via ALIAS_MAP, then look up again.
 *   5. If the provider was `openrouter` but the modelId carried a
 *      `<vendor>/<id>` prefix, use vendor as the provider.
 */
export function resolvePricing(
  providerId: string | undefined,
  modelId: string,
): { pricing: ModelPricing; resolvedKey: string } | null {
  // Normalize OpenRouter-style "anthropic/claude-..." IDs.
  let mid = modelId;
  let pid = providerId ?? "";
  const slashIdx = mid.indexOf("/");
  if (slashIdx > 0) {
    const vendor = mid.slice(0, slashIdx);
    const rest = mid.slice(slashIdx + 1);
    if (PROVIDER_ALIASES[vendor]) {
      pid = vendor;
      mid = rest;
    }
  }
  const canonicalProvider =
    PROVIDER_ALIASES[pid.toLowerCase()] ?? pid.toLowerCase();
  const section = TABLE[canonicalProvider];
  if (!section) return null;

  // Direct hit.
  const direct = section[mid];
  if (direct)
    return { pricing: direct, resolvedKey: `${canonicalProvider}/${mid}` };

  // Alias hit.
  const aliased = ALIAS_MAP[mid];
  if (aliased) {
    const hit = section[aliased];
    if (hit)
      return { pricing: hit, resolvedKey: `${canonicalProvider}/${aliased}` };
  }

  return null;
}

/**
 * Compute the cost in USD for an LLM call given its token usage.
 * Returns null when the model isn't priced in the table — callers should
 * decide whether to surface that as "(unpriced)" or log a warning.
 */
export function computeCost(
  providerId: string | undefined,
  modelId: string,
  usage: TokenUsage,
): CostBreakdown | null {
  const resolved = resolvePricing(providerId, modelId);
  if (!resolved) return null;
  const { pricing, resolvedKey } = resolved;

  const million = 1_000_000;
  const uncachedInputTokens =
    usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
  const inputCost =
    (Math.max(0, uncachedInputTokens) * pricing.input) / million;
  const cacheReadCost =
    pricing.cachedRead != null
      ? (usage.cacheReadTokens * pricing.cachedRead) / million
      : 0;
  const cacheWriteCost =
    pricing.cacheWrite != null
      ? (usage.cacheWriteTokens * pricing.cacheWrite) / million
      : 0;
  const outputCost = (usage.outputTokens * pricing.output) / million;
  const total = inputCost + cacheReadCost + cacheWriteCost + outputCost;
  const uncachedEquivalent =
    (usage.inputTokens * pricing.input + usage.outputTokens * pricing.output) /
    million;

  return {
    total,
    inputCost,
    cacheReadCost,
    cacheWriteCost,
    outputCost,
    uncachedEquivalent,
    pricing,
    resolvedKey,
  };
}
