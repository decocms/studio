/**
 * local-language-model — portable language-model factory for the desktop tree.
 *
 * Mirrors `apps/mesh/src/ai-providers/language-model.ts:createLanguageModel`
 * but takes a STRUCTURALLY-typed provider (`{ aiSdk: { languageModel } }`,
 * satisfied by `provider-from-secret`'s `DesktopProvider`) instead of importing
 * `@/ai-providers/types`'s `MeshProvider`. That severs the cluster type chain.
 *
 * Behaviour parity: when the model advertises the "reasoning" capability (i.e.
 * `capabilities.reasoning !== false`) we forward the provider-specific
 * `{ reasoning: { enabled, effort } }` setting, exactly like the cluster.
 */

import type { LanguageModel } from "ai";

/** Minimal provider shape — a subset of `MeshProvider` / `DesktopProvider`. */
export interface LanguageModelProvider {
  aiSdk: {
    // biome-ignore lint/suspicious/noExplicitAny: provider-specific settings pass-through
    languageModel: (modelId: string, settings?: any) => LanguageModel;
  };
}

/** Minimal model descriptor — a subset of the cluster `ModelInfo`. */
export interface LanguageModelInfo {
  id: string;
  capabilities?: { reasoning?: boolean };
}

export function createLanguageModel(
  provider: LanguageModelProvider,
  model: LanguageModelInfo,
): LanguageModel {
  if (model.capabilities?.reasoning !== false) {
    return provider.aiSdk.languageModel(model.id, {
      reasoning: { enabled: true, effort: "medium" },
    });
  }
  return provider.aiSdk.languageModel(model.id);
}
