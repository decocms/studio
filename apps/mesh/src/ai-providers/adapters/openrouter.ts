import { createOpenAI } from "@ai-sdk/openai";
import type {
  MeshProvider,
  ModelInfo,
  OAuthPkceResult,
  OpenRouterModel,
  ProviderAdapter,
} from "../types";

export const openrouterAdapter: ProviderAdapter = {
  info: {
    id: "openrouter",
    name: "OpenRouter",
    description: "Unified API for multiple AI providers",
    logo: "https://openrouter.ai/favicon.ico",
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
    const aiSdk = createOpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
    });

    const headers = { Authorization: `Bearer ${apiKey}` };

    return {
      info: this.info,
      aiSdk,

      async listModels(): Promise<ModelInfo[]> {
        const res = await fetch("https://openrouter.ai/api/v1/models", {
          headers,
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          throw new Error(`OpenRouter listModels failed: ${res.status}`);
        }
        const data = await res.json();
        return data.data.map((m: OpenRouterModel) => ({
          modelId: m.canonical_slug,
          title: m.name,
          description: m.description,
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
        }));
      },
    };
  },
};
