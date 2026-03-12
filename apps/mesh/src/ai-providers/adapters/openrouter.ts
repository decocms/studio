import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type {
  MeshProvider,
  ModelInfo,
  OAuthPkceResult,
  OpenRouterFrontendModel,
  OpenRouterAPIModel,
  ProviderAdapter,
} from "../types";
import { OPENROUTER_ICON_URL } from "@/web/utils/ai-providers-logos";

export const openrouterAdapter: ProviderAdapter = {
  info: {
    id: "openrouter",
    name: "OpenRouter",
    description: "Unified API for multiple AI providers",
    logo: OPENROUTER_ICON_URL,
  },

  supportedMethods: ["oauth-pkce", "api-key"],

  getOAuthUrl({ callbackUrl, codeChallenge, codeChallengeMethod }) {
    const params = new URLSearchParams({
      callback_url: callbackUrl,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
    });
    return `https://openrouter.ai/auth?${params}`;
  },

  async exchangeOAuthCode({
    code,
    codeVerifier,
    codeChallengeMethod,
  }): Promise<OAuthPkceResult> {
    const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        code_challenge_method: codeChallengeMethod,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`OpenRouter OAuth exchange failed: ${res.status}`);
    }
    const data = await res.json();
    return { apiKey: data.key, userId: data.user_id };
  },

  create(apiKey): MeshProvider {
    const aiSdk = createOpenRouter({
      apiKey,
    });

    const headers = { Authorization: `Bearer ${apiKey}` };

    return {
      info: this.info,
      aiSdk,

      async listModels(): Promise<ModelInfo[]> {
        const mapFrontendModel = (m: OpenRouterFrontendModel): ModelInfo => ({
          providerId: "openrouter",
          modelId: m.slug,
          title: m.name,
          description: m.description ?? null,
          logo: null,
          capabilities: [
            ...new Set([...m.input_modalities, ...m.output_modalities]),
          ],
          limits: {
            contextWindow: m.context_length ?? 0,
            maxOutputTokens: m.endpoint?.max_completion_tokens ?? null,
          },
          costs: m.endpoint?.pricing
            ? {
                input: Number(m.endpoint.pricing.prompt ?? 0),
                output: Number(m.endpoint.pricing.completion ?? 0),
              }
            : null,
        });

        const mapV1Model = (m: OpenRouterAPIModel): ModelInfo => ({
          providerId: "openrouter",
          modelId: m.canonical_slug,
          title: m.name,
          description: m.description ?? null,
          logo: null,
          capabilities: [
            ...new Set([
              ...m.architecture.input_modalities,
              ...m.architecture.output_modalities,
            ]),
          ],
          limits: {
            contextWindow: m.context_length ?? 0,
            maxOutputTokens: m.top_provider.max_completion_tokens || null,
          },
          costs: {
            input: m.pricing.prompt ?? 0,
            output: m.pricing.completion ?? 0,
          },
        });

        try {
          const res = await fetch(
            "https://openrouter.ai/api/frontend/models/find?order=most-popular",
            { signal: AbortSignal.timeout(15_000) },
          );
          if (!res.ok) throw new Error(`status ${res.status}`);
          const data = await res.json();
          const models: OpenRouterFrontendModel[] = data.data.models;
          if (!Array.isArray(models) || models.length === 0) {
            console.log("unexpected response shape");
            throw new Error("unexpected response shape");
          }
          return models.map(mapFrontendModel);
        } catch {
          console.log("fallback to v1");
          const res = await fetch("https://openrouter.ai/api/v1/models", {
            headers,
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) {
            throw new Error(`OpenRouter listModels failed: ${res.status}`);
          }
          const data = await res.json();
          return data.data.map(mapV1Model);
        }
      },
    };
  },
};
