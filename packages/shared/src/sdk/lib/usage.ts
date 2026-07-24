/**
 * Usage utilities for extracting cost and token stats from AI provider metadata.
 *
 * Supports provider-specific cost extraction (e.g., OpenRouter)
 * and aggregation of usage across messages or streaming steps.
 */

// ============================================================================
// Types
// ============================================================================

export interface UsageData {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /**
   * AI SDK normalizes cache token counts across providers via
   * usage.inputTokenDetails — populated identically by the anthropic,
   * openai, google and openrouter adapters. `cachedInputTokens` is the
   * convenience shorthand the AI SDK also surfaces (= cacheReadTokens).
   */
  cachedInputTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    noCacheTokens?: number;
  };
  providerMetadata?: {
    [key: string]: unknown;
  };
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
  /** Tokens read from prompt cache (anthropic / openrouter / openai / google). */
  cacheReadTokens: number;
  /** Tokens written to prompt cache (Anthropic only — others auto-cache without separate billing). */
  cacheWriteTokens: number;
}

type ProviderCostExtractor = (
  providerMetadata: NonNullable<UsageData["providerMetadata"]>,
) => number | null;

// ============================================================================
// Provider-specific cost extractors
// ============================================================================

/**
 * Registry of provider-specific cost extractors.
 * Each extractor attempts to get the cost from provider metadata.
 */
const PROVIDER_COST_EXTRACTORS: Record<string, ProviderCostExtractor> = {
  openrouter: (providerMetadata) => {
    const openrouter = providerMetadata?.openrouter;
    if (
      typeof openrouter === "object" &&
      openrouter !== null &&
      "usage" in openrouter &&
      typeof openrouter.usage === "object" &&
      openrouter.usage !== null &&
      "cost" in openrouter.usage &&
      typeof openrouter.usage.cost === "number"
    ) {
      return openrouter.usage.cost;
    }
    return null;
  },
};

// ============================================================================
// Cost extraction
// ============================================================================

/**
 * Extract cost from usage metadata by checking all known provider formats.
 */
export function getCostFromUsage(usage: UsageData | null | undefined): number {
  if (!usage?.providerMetadata) {
    return 0;
  }

  for (const extractor of Object.values(PROVIDER_COST_EXTRACTORS)) {
    const cost = extractor(usage.providerMetadata);
    if (cost !== null) {
      return cost;
    }
  }

  return 0;
}

// ============================================================================
// Provider metadata sanitization
// ============================================================================

const ALLOWED_PROVIDER_FIELDS = ["usage", "cost", "model"] as const;

/**
 * Sanitize provider metadata to prevent leaking sensitive data.
 * Only allows whitelisted fields: usage, cost, model.
 */
export function sanitizeProviderMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  const sanitized: Record<string, unknown> = {};
  for (const provider in metadata) {
    const providerData = metadata[provider];
    if (typeof providerData === "object" && providerData !== null) {
      const safeData: Record<string, unknown> = {};
      for (const field of ALLOWED_PROVIDER_FIELDS) {
        if (field in providerData) {
          safeData[field] = (providerData as Record<string, unknown>)[field];
        }
      }
      sanitized[provider] = safeData;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

// ============================================================================
// Usage accumulation
// ============================================================================

/**
 * Create an empty UsageStats object.
 */
export function emptyUsageStats(): UsageStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cost: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/**
 * Accumulate a step's usage into an existing UsageStats total.
 * Returns a new UsageStats object (immutable).
 */
export function addUsage(
  accumulated: UsageStats,
  stepUsage: UsageData | null | undefined,
): UsageStats {
  if (!stepUsage) return accumulated;

  const cacheRead =
    stepUsage.inputTokenDetails?.cacheReadTokens ??
    stepUsage.cachedInputTokens ??
    0;
  const cacheWrite = stepUsage.inputTokenDetails?.cacheWriteTokens ?? 0;

  return {
    inputTokens: accumulated.inputTokens + (stepUsage.inputTokens ?? 0),
    outputTokens: accumulated.outputTokens + (stepUsage.outputTokens ?? 0),
    reasoningTokens:
      accumulated.reasoningTokens + (stepUsage.reasoningTokens ?? 0),
    totalTokens: accumulated.totalTokens + (stepUsage.totalTokens ?? 0),
    cost: accumulated.cost + getCostFromUsage(stepUsage),
    cacheReadTokens: accumulated.cacheReadTokens + cacheRead,
    cacheWriteTokens: accumulated.cacheWriteTokens + cacheWrite,
  };
}

/**
 * Calculate aggregated usage stats from an array of messages.
 * Each message is expected to have an optional `metadata.usage` field.
 */
export function calculateUsageStats(
  messages: Array<{ metadata?: { usage?: UsageData } }>,
): UsageStats {
  return messages.reduce<UsageStats>(
    (acc, message) => addUsage(acc, message.metadata?.usage),
    emptyUsageStats(),
  );
}
