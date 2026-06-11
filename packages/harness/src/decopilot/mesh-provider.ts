/**
 * mesh-provider — the portable provider surface + language-model factory.
 *
 * This file is the ONE home for `MeshProvider` + `createLanguageModel`, shared
 * by the cluster (the `@/ai-providers/*` aliases re-export from here) and the
 * desktop daemon (which deep-imports the harnesses subtree). It imports ONLY
 * AI-SDK + `@decocms/mesh-sdk` + relative paths — no
 * `@/*` specifier and no StudioContext — so the daemon bundles it without the
 * tsc stack overflow that cluster types induce.
 */

import type { ProviderV3 } from "@ai-sdk/provider";
import type { ModelCapability, ProviderId } from "@decocms/mesh-sdk";

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  description: string;
  logo?: string;
}

export interface ModelInfo {
  providerId: ProviderId;
  modelId: string;
  title: string;
  description?: string | null;
  logo?: string | null;
  capabilities: ModelCapability[];
  limits?: { contextWindow: number; maxOutputTokens: number | null } | null;
  costs: { input: number; output: number } | null;
  /** When true the upstream provider has flagged this model as deprecated. */
  deprecated?: boolean;
  /** Mirrors `AiProviderModel.asyncResearch` — restricts this model to the
   *  deep-research slot. */
  asyncResearch?: boolean;
}

export interface AsyncResearchResult {
  text: string;
  citations: Array<{ url: string; title?: string }>;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Generic capability for "research" jobs that don't fit streamText — they're
 * submit-then-poll, take minutes, and need to survive pod death. Each adapter
 * decides which of its models route through this path; the caller doesn't
 * know whether the underlying protocol is Gemini's Interactions API,
 * something OpenAI ships later, etc.
 */
export interface AsyncResearchProvider {
  /** Whether the given model id should be driven through this capability. */
  canHandle(modelId: string): boolean;
  /** Submit a new job. Returns an adapter-opaque handle that survives restarts. */
  start(req: {
    modelId: string;
    query: string;
    abortSignal?: AbortSignal;
  }): Promise<{ jobId: string }>;
  /**
   * Drive an already-submitted job to terminal state. Same call works for the
   * pod that submitted it AND for a fresh pod resuming after a crash.
   */
  resume(req: {
    jobId: string;
    abortSignal?: AbortSignal;
    onProgress?: (transcript: string) => void;
    pollIntervalMs?: number;
  }): Promise<AsyncResearchResult>;
}

export interface MeshProvider {
  readonly info: ProviderInfo;
  readonly aiSdk: ProviderV3;
  /** Set by providers that expose async/long-running research jobs. */
  readonly asyncResearch?: AsyncResearchProvider;
  listModels(): Promise<ModelInfo[]>;
}

/**
 * Minimal provider shape `createLanguageModel` needs — satisfied by both the
 * full `MeshProvider` and the desktop's `provider-from-secret` result.
 */
interface LanguageModelProvider {
  aiSdk: Pick<ProviderV3, "languageModel">;
}

/**
 * Minimal model descriptor `createLanguageModel` needs — satisfied by the wire
 * `ModelSelection` (`../types`) and the cluster request-shaped `ModelInfo`.
 */
interface LanguageModelSelection {
  id: string;
  capabilities?: { reasoning?: boolean };
}

/**
 * Creates a language model from the provider, enabling reasoning when the
 * model advertises the "reasoning" capability (e.g. OpenRouter thinking models).
 */
export function createLanguageModel(
  provider: LanguageModelProvider,
  model: LanguageModelSelection,
) {
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
