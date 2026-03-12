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
      "qwen",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-sonnet",
      "anthropic/claude",
    ],
  };

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
  providerId: string,
  keyId?: string,
): AiProviderModel | null {
  if (models.length === 0) return null;

  const candidates = DEFAULT_MODEL_PREFERENCES[providerId as ProviderId] ?? [];

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
