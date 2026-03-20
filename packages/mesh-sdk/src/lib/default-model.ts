import type { AiProviderModel, ProviderId } from "../types/ai-providers";

/**
 * Preferred default models for each well-known provider.
 *
 * Each entry is an ordered list of candidate model ID strings — lower indexes
 * have higher priority. The selector first tries exact matches across the full
 * list, then falls back to substring matches in the same priority order.
 */
export const DEFAULT_MODEL_PREFERENCES: Partial<Record<ProviderId, string[]>> =
  {
    anthropic: ["claude-sonnet-4-6", "claude-sonnet", "claude"],
    openrouter: [
      "anthropic/claude-opus-4.6",
      "anthropic/claude-4.6-opus",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-sonnet",
      "anthropic/claude",
    ],
    deco: [
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-haiku",
      "anthropic/claude",
    ],
    google: ["gemini-3-flash"],
    "claude-code": [
      "claude-code:sonnet",
      "claude-code:opus",
      "claude-code:haiku",
    ],
  };

/**
 * Preferred fast/cheap models per provider — used for lightweight tasks
 * like title generation where latency and cost matter more than capability.
 */
export const FAST_MODEL_PREFERENCES: Partial<Record<ProviderId, string[]>> = {
  anthropic: ["claude-haiku-4-5", "claude-haiku"],
  openrouter: [
    "qwen/qwen3.5-flash",
    "anthropic/claude-haiku-4.5",
    "anthropic/claude-haiku",
    "google/gemini-3-flash",
  ],
  deco: ["qwen/qwen3.5-flash", "anthropic/claude-haiku"],
  google: ["gemini-2.5-flash", "gemini-3-flash"],
};

/**
 * Return the preferred fast model ID for a given provider.
 * Returns the first candidate or `null` if no preference is configured.
 */
export function getFastModel(providerId: ProviderId): string | null {
  const candidates = FAST_MODEL_PREFERENCES[providerId];
  return candidates?.[0] ?? null;
}

/**
 * Select the best default model from a loaded list for a given provider.
 *
 * Resolution order:
 *   1. Exact `modelId` match — walk candidates in priority order.
 *   2. Substring match — walk candidates in priority order, return the first
 *      model whose `modelId` contains the candidate string.
 *   3. First model in the list.
 *   4. `null` if the list is empty.
 *
 * @param models      Full model list returned by the provider for this key.
 * @param providerId  The provider that owns the key.
 * @param keyId       Credential key ID to attach — mirrors what
 *                    `handleModelSelect` does on explicit user selection.
 */
export function selectDefaultModel(
  models: AiProviderModel[],
  providerId: ProviderId,
  keyId?: string,
): AiProviderModel | null {
  if (models.length === 0) return null;

  const candidates = DEFAULT_MODEL_PREFERENCES[providerId] ?? [];

  const withKey = (model: AiProviderModel): AiProviderModel =>
    keyId !== undefined ? { ...model, keyId } : model;

  for (const candidate of candidates) {
    const exact = models.find((m) => m.modelId === candidate);
    if (exact) return withKey(exact);
  }

  for (const candidate of candidates) {
    const partial = models.find((m) => m.modelId.includes(candidate));
    if (partial) return withKey(partial);
  }

  return withKey(models[0] as AiProviderModel);
}
