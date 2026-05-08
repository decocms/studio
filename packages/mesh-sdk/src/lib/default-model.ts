import type {
  AiProviderModel,
  AiProviderKey,
  ProviderId,
} from "../types/ai-providers";

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
      "anthropic/claude-opus-4.7",
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
  "claude-code": ["claude-code:haiku", "claude-code:sonnet"],
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
 * Preferred smart (balanced) models per provider — used as the "Smart" tier
 * in Simple Model Mode.
 */
export const SMART_MODEL_PREFERENCES: Partial<Record<ProviderId, string[]>> = {
  anthropic: ["claude-sonnet-4-6", "claude-sonnet"],
  openrouter: [
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-sonnet",
    "anthropic/claude-opus-4.7",
    "google/gemini-3-pro",
  ],
  deco: [
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-sonnet",
    "anthropic/claude",
  ],
  google: ["gemini-3-pro", "gemini-3-flash"],
  "claude-code": ["claude-code:sonnet"],
};

/**
 * Preferred thinking/reasoning models per provider — used as the "Thinking" tier
 * in Simple Model Mode.
 */
export const THINKING_MODEL_PREFERENCES: Partial<Record<ProviderId, string[]>> =
  {
    anthropic: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-sonnet"],
    openrouter: [
      "anthropic/claude-opus-4.7",
      "anthropic/claude-sonnet-4.6:extended",
      "anthropic/claude-sonnet-4.6",
      "google/gemini-3-pro",
    ],
    deco: [
      "anthropic/claude-opus",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-sonnet",
    ],
    google: ["gemini-3-pro"],
    "claude-code": ["claude-code:opus", "claude-code:sonnet"],
  };

/**
 * Preferred image generation models per provider.
 * Falls back to first model with "image" capability.
 */
export const IMAGE_MODEL_PREFERENCES: Partial<Record<ProviderId, string[]>> = {
  openrouter: ["openai/gpt-image-1", "google/gemini-2.0-flash-image"],
  deco: ["openai/gpt-image-1", "google/gemini-2.0-flash-image"],
  google: ["gemini-2.0-flash-image"],
};

/**
 * Preferred web research models per provider.
 * Falls back to first model whose id includes "sonar" or "deepresearch".
 */
export const WEB_RESEARCH_MODEL_PREFERENCES: Partial<
  Record<ProviderId, string[]>
> = {
  openrouter: [
    "perplexity/sonar",
    "perplexity/sonar-pro",
    "perplexity/deep-research",
  ],
  deco: [
    "perplexity/sonar",
    "perplexity/sonar-pro",
    "perplexity/deep-research",
  ],
};

export interface SimpleModeModelSlot {
  keyId: string;
  modelId: string;
  title?: string;
}

export interface SimpleModeDefaults {
  chat: {
    fast: SimpleModeModelSlot | null;
    smart: SimpleModeModelSlot | null;
    thinking: SimpleModeModelSlot | null;
  };
  image: SimpleModeModelSlot | null;
  webResearch: SimpleModeModelSlot | null;
}

function resolveSlot(
  models: AiProviderModel[],
  keyId: string,
  preferences: string[],
  fallback?: (m: AiProviderModel) => boolean,
): SimpleModeModelSlot | null {
  for (const candidate of preferences) {
    const exact = models.find((m) => m.modelId === candidate);
    if (exact) return { keyId, modelId: exact.modelId, title: exact.title };
  }
  for (const candidate of preferences) {
    const partial = models.find((m) => m.modelId.includes(candidate));
    if (partial)
      return { keyId, modelId: partial.modelId, title: partial.title };
  }
  if (fallback) {
    const found = models.find(fallback);
    if (found) return { keyId, modelId: found.modelId, title: found.title };
  }
  return null;
}

/**
 * Compute sensible Simple Mode defaults from the currently-connected keys and
 * their available models. Each slot picks the best candidate per the tier
 * preference lists, falling back to capability-based detection for image/web.
 *
 * @param keys       The org's connected AI provider keys.
 * @param modelsByKeyId  Map of keyId → available model list.
 */
export function pickSimpleModeDefaults(
  keys: AiProviderKey[],
  modelsByKeyId: Record<string, AiProviderModel[]>,
): SimpleModeDefaults {
  const result: SimpleModeDefaults = {
    chat: { fast: null, smart: null, thinking: null },
    image: null,
    webResearch: null,
  };

  for (const key of keys) {
    const models = modelsByKeyId[key.id] ?? [];
    const providerId = key.providerId as ProviderId;

    if (!result.chat.fast) {
      result.chat.fast = resolveSlot(
        models,
        key.id,
        FAST_MODEL_PREFERENCES[providerId] ?? [],
      );
    }
    if (!result.chat.smart) {
      result.chat.smart = resolveSlot(
        models,
        key.id,
        SMART_MODEL_PREFERENCES[providerId] ?? [],
      );
    }
    if (!result.chat.thinking) {
      result.chat.thinking = resolveSlot(
        models,
        key.id,
        THINKING_MODEL_PREFERENCES[providerId] ?? [],
      );
    }
    if (!result.image) {
      result.image = resolveSlot(
        models,
        key.id,
        IMAGE_MODEL_PREFERENCES[providerId] ?? [],
        (m) => m.capabilities?.includes("image") === true,
      );
    }
    if (!result.webResearch) {
      result.webResearch = resolveSlot(
        models,
        key.id,
        WEB_RESEARCH_MODEL_PREFERENCES[providerId] ?? [],
        (m) => {
          const n = m.modelId.toLowerCase().replace(/[^a-z0-9]/g, "");
          return n.includes("sonar") || n.includes("deepresearch");
        },
      );
    }
  }

  return result;
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
