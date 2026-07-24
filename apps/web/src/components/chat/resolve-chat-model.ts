import { pickSimpleModeDefaults } from "@/sdk";
import type {
  AiProviderKey,
  AiProviderModel,
} from "../../hooks/collections/use-ai-providers";

export type ModelRef = { keyId: string; modelId: string };
export type SimpleTier = "fast" | "smart" | "thinking";

/**
 * Resolve a stored ModelRef against the currently available keys and models.
 * Returns null when the ref's key no longer exists. Match is by `modelId`
 * only within `allModels` — the API-returned model objects don't carry
 * `keyId` (it's a client-side-only field), so we attach it ourselves.
 * When the model isn't in the provided list (list still loading, or list
 * scoped to a different credential), synthesize a minimal AiProviderModel
 * from the ref so callers always get a routable `{ keyId, modelId }`.
 */
export function findModel(
  ref: ModelRef | null,
  allKeys: AiProviderKey[],
  allModels: AiProviderModel[],
  title?: string,
): AiProviderModel | null {
  if (!ref) return null;
  const key = allKeys.find((k) => k.id === ref.keyId);
  if (!key) return null;
  const hit = allModels.find((m) => m.modelId === ref.modelId);
  if (hit) return { ...hit, keyId: ref.keyId };
  return {
    modelId: ref.modelId,
    title: title ?? ref.modelId,
    keyId: ref.keyId,
    providerId: key.providerId,
    description: null,
    logo: null,
    capabilities: [],
    limits: null,
    costs: null,
  } as AiProviderModel;
}

/**
 * Pick the active chat tier from the user's stored choice, defaulting to
 * "smart". All three chat tiers are always selectable — the backend's
 * resolveTier() falls back to SDK provider defaults when the org's tier
 * slot is unset, so we don't need to gate on slot configuration here.
 */
export function resolveActiveTier(stored: SimpleTier | null): SimpleTier {
  if (stored === "fast" || stored === "smart" || stored === "thinking") {
    return stored;
  }
  return "smart";
}

/**
 * Mirror backend resolveTier() when no slot is explicitly assigned: pick a
 * tier-appropriate default from the effective key's catalog so the UI can
 * read capabilities (file upload, vision, etc.) instead of falling back to
 * a null model. Backend pickSimpleModeDefaults considers all keys; we only
 * have the effective key's catalog client-side, so multi-key orgs may see a
 * single-key-derived default. This matches the backend's pick when the
 * effective key is also the first match for the tier.
 */
export function pickFallbackChatModel(
  tier: SimpleTier,
  keys: AiProviderKey[],
  effectiveKeyId: string | null,
  models: AiProviderModel[],
): AiProviderModel | null {
  if (!effectiveKeyId || models.length === 0) return null;
  const key = keys.find((k) => k.id === effectiveKeyId);
  if (!key) return null;
  const defaults = pickSimpleModeDefaults([key], {
    [effectiveKeyId]: models,
  });
  const slot =
    tier === "fast"
      ? defaults.chat.fast
      : tier === "thinking"
        ? defaults.chat.thinking
        : defaults.chat.smart;
  if (!slot) return null;
  const full = models.find((m) => m.modelId === slot.modelId);
  if (!full) return null;
  return { ...full, keyId: effectiveKeyId };
}
