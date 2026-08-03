/**
 * studio-provider — the portable provider surface + language-model factory.
 *
 * This file is the ONE home for `StudioProvider` + `createLanguageModel`; the
 * cluster's `@/ai-providers/*` aliases re-export from here. It imports only
 * AI-SDK, `@decocms/shared/sdk`, and relative paths so the provider core stays
 * portable and testable without StudioContext.
 */

import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { ProviderV3 } from "@ai-sdk/provider";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import type { ModelCapability, ProviderId } from "@decocms/shared/sdk";
import { isCreditError } from "../stream-error";
import { withThoughtSignatureCodec } from "./thought-signature";

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

export interface StudioProvider {
  readonly info: ProviderInfo;
  readonly aiSdk: ProviderV3;
  /** Set by providers that expose async/long-running research jobs. */
  readonly asyncResearch?: AsyncResearchProvider;
  listModels(): Promise<ModelInfo[]>;
}

/**
 * Minimal provider shape `createLanguageModel` needs — satisfied by both the
 * full `StudioProvider` and the desktop's `provider-from-secret` result.
 */
interface LanguageModelProvider {
  /** Provider id (e.g. "openrouter", "deco") — drives the OpenRouter-family
   *  model fallback below. Optional so minimal callers/tests still satisfy it. */
  info?: { id: string };
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

const FREE_FALLBACK_MODEL = "openrouter/free";

/**
 * Provider ids whose wire format (OpenAI chat-completions) can't carry a
 * Gemini thought signature in metadata, so gateways smuggle it into the
 * tool-call id (`call_<base>__thought__<sig>`). These get the thought-signature
 * codec; everyone else (native google, anthropic, …) already handles signatures
 * natively. The codec is a no-op for ids without the separator, so listing a
 * gateway that doesn't embed costs nothing.
 */
const THOUGHT_SIGNATURE_ID_PROVIDERS = new Set<string>([
  "openai-compatible",
  "openrouter",
  "deco",
  "llmapi",
]);

/**
 * Re-issues the SAME call against `free` on an account-level credit rejection
 * (402) from `primary`, before any chunk is produced. This is the gap the
 * in-request `models` array can't cover: a 402 terminates the whole request
 * before model routing, so the array never reaches the free model. If the free
 * retry also fails, the original error propagates. Only fires for the
 * 402-at-request-start path (rejected `doStream`/`doGenerate`); mid-stream
 * errors aren't credit errors.
 */
function withCreditFallback(
  primary: LanguageModelV3,
  free: LanguageModelV3,
): LanguageModelV3 {
  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v3",
    wrapStream: async ({ doStream, params }) => {
      try {
        return await doStream();
      } catch (err) {
        if (!isCreditError(err)) throw err;
        return free.doStream(params);
      }
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      try {
        return await doGenerate();
      } catch (err) {
        if (!isCreditError(err)) throw err;
        return free.doGenerate(params);
      }
    },
  };
  return wrapLanguageModel({ model: primary, middleware });
}

/**
 * Creates a language model from the provider.
 *
 * - Enables reasoning when the model advertises the "reasoning" capability
 *   (e.g. OpenRouter thinking models).
 * - For the raw OpenRouter provider, attaches a native model-fallback list
 *   (`models: [primary, openrouter/free]`) for transient model failures
 *   (provider down / rate-limit / moderation) handled at OpenRouter's edge,
 *   AND wraps the model with `withCreditFallback` for account-level 402s the
 *   array can't reach. Excluded for the deco AI gateway, which gates even free
 *   models on the org credit balance, so a free fallback can't succeed there.
 */
export function createLanguageModel(
  provider: LanguageModelProvider,
  model: LanguageModelSelection,
) {
  const settings: Record<string, unknown> = {};

  if (model.capabilities?.reasoning !== false) {
    settings.reasoning = { enabled: true, effort: "medium" };
  }
  const useFreeFallback =
    provider.info?.id === "openrouter" && model.id !== FREE_FALLBACK_MODEL;
  if (useFreeFallback) {
    settings.models = [model.id, FREE_FALLBACK_MODEL];
  }

  // Provider-specific settings (reasoning / models fallback) are not part of
  // the generic ProviderV3 interface, so we cast to pass them through.
  const make = (id: string, s?: Record<string, unknown>): LanguageModelV3 =>
    (s && Object.keys(s).length > 0
      ? // biome-ignore lint/complexity/noBannedTypes: pass-through provider settings
        (provider.aiSdk.languageModel as Function)(id, s)
      : provider.aiSdk.languageModel(id)) as LanguageModelV3;

  const primary = make(model.id, settings);
  // Free model is plain (no reasoning, no nested models array) so the retry is
  // a clean single-model call.
  const base = useFreeFallback
    ? withCreditFallback(primary, make(FREE_FALLBACK_MODEL))
    : primary;

  // Decode Gemini thought signatures the gateway packs into tool-call ids.
  // Outermost so its `transformParams` rewrites ids before the credit-fallback
  // re-issues the call against the free model.
  return provider.info?.id &&
    THOUGHT_SIGNATURE_ID_PROVIDERS.has(provider.info.id)
    ? withThoughtSignatureCodec(base)
    : base;
}
