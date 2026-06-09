/**
 * provider-from-secret — build an AI-SDK language-model provider directly from
 * the injected `mcp.modelSecret`, importing ONLY `@ai-sdk/*` provider packages.
 *
 * ⚠️ This is the import-isolation linchpin. The cluster activates its chat
 * model via `ctx.aiProviders.activate(credentialId, orgId)` → vault lookup →
 * `MeshProvider` (`@/ai-providers/*`). That whole chain reaches into
 * `StudioContext`, the vault, and storage — none of which exist (or are safe)
 * on the desktop daemon. Instead, the cluster injects a single, pre-resolved
 * chat-completion secret (`HarnessStreamInput.mcp.modelSecret`) and the desktop
 * constructs the provider locally from the matching `@ai-sdk/*` factory.
 *
 * NEVER import `@/ai-providers/*`, the vault, or `MeshProvider` here. The only
 * dependencies are the provider SDK packages, mirroring how the cluster's own
 * adapters (`apps/mesh/src/ai-providers/adapters/*`) build their `aiSdk`:
 *   - anthropic            → createAnthropic({ apiKey })
 *   - google               → createGoogleGenerativeAI({ apiKey })
 *   - openrouter / deco     → createOpenRouter({ apiKey })  (deco gateway is an
 *                             OpenRouter-backed gateway; same SDK)
 *   - openai-compatible     → createOpenAI({ baseURL, apiKey }).chat  (LiteLLM,
 *                             Ollama, and other /v1/chat/completions servers)
 *
 * The returned shape `{ aiSdk: { languageModel } }` is the minimal structural
 * subset of `MeshProvider` that `createLanguageModel` (./local-language-model)
 * reads — so the lean loop never sees `MeshProvider` or its type chain.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

/** The injected secret shape (mirrors `HarnessStreamInput.mcp.modelSecret`). */
export interface ModelSecret {
  /** Provider identifier, e.g. "anthropic", "openai-compatible", "openrouter". */
  providerId: string;
  /** Resolved API key (or credential secret). Plaintext over HTTPS. */
  apiKey: string;
  /** Optional endpoint override for self-hosted/LiteLLM deployments. */
  baseUrl?: string;
  /** Additional request headers the provider adapter requires. */
  extraHeaders?: Record<string, string>;
}

/** The minimal provider shape the lean loop consumes. Structurally a subset of
 *  the cluster's `MeshProvider` (`provider.aiSdk.languageModel(id, opts?)`). */
export interface DesktopProvider {
  aiSdk: {
    // biome-ignore lint/suspicious/noExplicitAny: provider-specific extra settings (e.g. reasoning) are passed through
    languageModel: (modelId: string, settings?: any) => LanguageModel;
  };
}

/**
 * Build a `DesktopProvider` from the injected model secret. Maps `providerId`
 * to the matching `@ai-sdk/*` factory and returns only the `aiSdk.languageModel`
 * surface the lean agent loop needs.
 *
 * Throws on an unknown `providerId` — the cluster only ever injects a secret
 * for a provider it itself supports, so an unknown id means a wiring bug, not a
 * recoverable runtime state.
 */
export function createProviderFromSecret(secret: ModelSecret): DesktopProvider {
  const { providerId, apiKey, baseUrl, extraHeaders } = secret;

  switch (providerId) {
    case "anthropic": {
      const aiSdk = createAnthropic({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        ...(extraHeaders ? { headers: extraHeaders } : {}),
      });
      return { aiSdk };
    }

    case "google": {
      const aiSdk = createGoogleGenerativeAI({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        ...(extraHeaders ? { headers: extraHeaders } : {}),
      });
      return { aiSdk };
    }

    case "openrouter":
    // The deco AI gateway is an OpenRouter-backed gateway; the cluster's
    // `deco-ai-gateway` adapter delegates straight to `openrouterAdapter.create`.
    // Same SDK + apiKey here.
    case "deco": {
      const aiSdk = createOpenRouter({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        ...(extraHeaders ? { headers: extraHeaders } : {}),
      });
      // `createOpenRouter` returns an `OpenRouterProvider` whose call signature
      // differs from the bare `languageModel` we expose; `.languageModel` is the
      // stable method both shapes share.
      return {
        aiSdk: {
          languageModel: (modelId, settings) =>
            aiSdk.languageModel(modelId, settings),
        },
      };
    }

    case "openai-compatible": {
      // LiteLLM / Ollama / other OpenAI-compatible servers. The AI SDK appends
      // `/chat/completions` to baseURL, so the URL must end with `/v1` — mirror
      // the cluster's `openai-compatible` adapter normalization.
      let normalizedBaseUrl = (baseUrl ?? "").replace(/\/+$/, "");
      if (normalizedBaseUrl && !normalizedBaseUrl.endsWith("/v1")) {
        normalizedBaseUrl += "/v1";
      }
      const openai = createOpenAI({
        apiKey: apiKey || "not-needed",
        name: "openai-compatible",
        ...(normalizedBaseUrl ? { baseURL: normalizedBaseUrl } : {}),
        ...(extraHeaders ? { headers: extraHeaders } : {}),
      });
      // Use the chat-completions API (/v1/chat/completions), not the OpenAI
      // Responses API (/responses) which most compatible servers don't support.
      // Mirrors the cluster `openai-compatible` adapter, which sets
      // `languageModel: openai.chat` (no extra settings forwarded — the
      // reasoning setting is OpenRouter/Anthropic/Google-specific anyway).
      return {
        aiSdk: {
          languageModel: (modelId) => openai.chat(modelId),
        },
      };
    }

    default:
      throw new Error(
        `decopilot-desktop: unsupported modelSecret.providerId '${providerId}'. ` +
          "Supported: anthropic, google, openrouter, deco, openai-compatible.",
      );
  }
}
