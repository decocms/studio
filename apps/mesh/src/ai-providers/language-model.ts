/**
 * Language model factory.
 *
 * Builds a Vercel AI SDK language model from a `MeshProvider` and a
 * decopilot-side `ModelInfo` descriptor (the request-shaped one defined in
 * `api/routes/decopilot/types`, which carries capability flags). When the
 * model advertises the "reasoning" capability we forward the
 * provider-specific `{ reasoning: { enabled, effort } }` setting; otherwise
 * we hand back a plain language model.
 *
 * Extracted from `api/routes/decopilot/stream-core.ts` so that callers
 * outside the route handler (the decopilot harness, the subtask built-in
 * tool, future harnesses) can use it without inducing a circular import on
 * stream-core.
 */

import type { MeshProvider } from "./types";
import type { ModelInfo } from "../api/routes/decopilot/types";

/**
 * Creates a language model from the provider, enabling reasoning when the
 * model advertises the "reasoning" capability (e.g. OpenRouter thinking models).
 */
export function createLanguageModel(provider: MeshProvider, model: ModelInfo) {
  if (model.capabilities?.reasoning !== false) {
    // Provider-specific settings (e.g. OpenRouter reasoning) are not part of
    // the generic ProviderV3 interface, so we cast to pass them through.
    // biome-ignore lint/complexity/noBannedTypes: pass-through provider settings
    const lm = (provider.aiSdk.languageModel as Function)(model.id, {
      reasoning: { enabled: true, effort: "medium" },
    });
    return lm as ReturnType<typeof provider.aiSdk.languageModel>;
  }
  return provider.aiSdk.languageModel(model.id);
}
