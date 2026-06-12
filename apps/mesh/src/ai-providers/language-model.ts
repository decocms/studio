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

const FREE_FALLBACK_MODEL = "openrouter/free";

const OPENROUTER_FAMILY = new Set(["openrouter", "deco"]);

/**
 * Creates a language model from the provider.
 *
 * - Enables reasoning when the model advertises the "reasoning" capability
 *   (e.g. OpenRouter thinking models).
 * - For OpenRouter-family providers, attaches a native model-fallback list
 *   (`models: [primary, openrouter/free]`). When the primary fails for ANY
 *   reason — rate-limit, downtime, context-length, or a budget/credit
 *   rejection — OpenRouter retries on the free model instead of surfacing a
 *   hard error to the user. The response's `model` field reports whichever
 *   model actually served the request.
 */
export function createLanguageModel(provider: MeshProvider, model: ModelInfo) {
  const settings: Record<string, unknown> = {};

  if (model.capabilities?.reasoning !== false) {
    settings.reasoning = { enabled: true, effort: "medium" };
  }
  if (
    OPENROUTER_FAMILY.has(provider.info.id) &&
    model.id !== FREE_FALLBACK_MODEL
  ) {
    settings.models = [model.id, FREE_FALLBACK_MODEL];
  }

  if (Object.keys(settings).length === 0) {
    return provider.aiSdk.languageModel(model.id);
  }

  const lm = (provider.aiSdk.languageModel as Function)(model.id, settings);
  return lm as ReturnType<typeof provider.aiSdk.languageModel>;
}
