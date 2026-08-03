/**
 * Normalize the CLIENT models payload (root `credentialId`, client-only
 * extras) into the v2 per-slot harness/wire `ModelsConfig`.
 *
 * Each slot carries its own credentialId (decision D14), defaulting to the
 * chat credential when the client doesn't pin one. `coding` is dropped (D11).
 */
import type { ModelSelection, ModelsConfig } from "@/harnesses/lib/types";
import type { ModelInfo, ModelsConfig as ClientModelsConfig } from "./types";

/**
 * Honest widening of `ClientModelsConfig` to what callers actually send:
 *   - `smart` is not on the client type yet (no producer), but is normalized
 *     through when present so the slot survives the flip.
 *   - `coding` may still arrive from older clients / stored `run_config`
 *     rows; it is intentionally ignored (slot removed, D11).
 *   - `image`/`deepResearch` declare `credentialId` required on the client
 *     type, but resume/automation paths replay stored configs that predate
 *     it — so it is optional here and defaults to the root credential.
 *
 * Every `ClientModelsConfig` value is assignable to this type (pure
 * widening) — no casts needed at call sites.
 */
export type ClientModelsInput = Omit<
  ClientModelsConfig,
  "image" | "webSearch" | "deepResearch"
> & {
  image?: ModelInfo & { credentialId?: string };
  webSearch?: ModelInfo & { credentialId?: string };
  deepResearch?: ModelInfo & { credentialId?: string };
  smart?: ModelInfo;
  coding?: unknown;
};

/**
 * Project a client slot onto the wire `ModelSelection` shape.
 *
 * `capabilities` is forwarded (wire-only keys; see toSelection: `vision`/
 * `text`/`reasoning`) so `createLanguageModel`'s `reasoning !== false` gate
 * sees the client's flags on every harness, cluster or desktop (plan Task 13);
 * `coding` dropped (D11).
 */
function toSelection(slot: ModelInfo, credentialId: string): ModelSelection {
  // Project only the wire-allowed capability keys. A tools/file-only client
  // capabilities object has no wire-allowed key, so the projected object would
  // be empty — omit `capabilities` entirely in that case rather than emitting
  // `capabilities: {}` on the wire.
  const wireCapabilities = slot.capabilities
    ? {
        ...(slot.capabilities.vision !== undefined
          ? { vision: slot.capabilities.vision }
          : {}),
        ...(slot.capabilities.text !== undefined
          ? { text: slot.capabilities.text }
          : {}),
        ...(slot.capabilities.reasoning !== undefined
          ? { reasoning: slot.capabilities.reasoning }
          : {}),
      }
    : undefined;
  return {
    id: slot.id,
    ...(slot.title !== undefined ? { title: slot.title } : {}),
    ...(slot.provider !== undefined ? { provider: slot.provider } : {}),
    credentialId,
    ...(slot.limits ? { limits: slot.limits } : {}),
    ...(wireCapabilities && Object.keys(wireCapabilities).length > 0
      ? { capabilities: wireCapabilities }
      : {}),
  };
}

/**
 * Pure normalization of the client models payload into the v2 per-slot
 * shape. Behavior:
 *   - `thinking`/`fast`/`smart` resolve against the root client credential.
 *   - `image`/`deepResearch` keep their own `credentialId`, defaulting to
 *     the root credential when absent.
 *   - `capabilities` forwarded (wire-only keys; see toSelection); `coding`
 *     dropped (D11).
 *   - `thinking.title` falls back to the model id — the wire schema requires
 *     it (`modelSelectionSchema.extend({ title: z.string() })`) while the TS
 *     client type leaves it optional.
 */
export function normalizeClientModels(models: ClientModelsInput): ModelsConfig {
  const root = models.credentialId;
  const thinking = toSelection(models.thinking, root);
  return {
    thinking: { ...thinking, title: thinking.title ?? thinking.id },
    ...(models.fast ? { fast: toSelection(models.fast, root) } : {}),
    ...(models.smart ? { smart: toSelection(models.smart, root) } : {}),
    ...(models.image
      ? { image: toSelection(models.image, models.image.credentialId ?? root) }
      : {}),
    ...(models.webSearch
      ? {
          webSearch: toSelection(
            models.webSearch,
            models.webSearch.credentialId ?? root,
          ),
        }
      : {}),
    ...(models.deepResearch
      ? {
          deepResearch: toSelection(
            models.deepResearch,
            models.deepResearch.credentialId ?? root,
          ),
        }
      : {}),
  };
}
