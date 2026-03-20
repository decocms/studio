import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ModelCapability } from "@decocms/mesh-sdk";
import type {
  MeshProvider,
  ModelInfo,
  OAuthPkceResult,
  OpenRouterAPIModel,
  ProviderAdapter,
} from "../types";
const OPENROUTER_ICON_URL =
  "https://assets.decocache.com/decocms/b2e2f64f-6025-45f7-9e8c-3b3ebdd073d8/openrouter_logojpg.jpg";

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
        const mapV1Model = (m: OpenRouterAPIModel): ModelInfo => {
          return {
            providerId: "openrouter",
            modelId: m.id,
            title: m.name,
            description: m.description ?? null,
            logo: null,
            capabilities: [
              ...new Set([
                // OpenRouter uses "image" in input_modalities to mean vision (can see images).
                // Map it to "vision" so we distinguish from "image" (image generation output).
                ...m.architecture.input_modalities.map((mod) =>
                  mod === "image" ? "vision" : mod,
                ),
                ...m.architecture.output_modalities,
                ...(m.architecture.output_modalities?.includes("image")
                  ? (["image-generation"] as const)
                  : []),
                ...(m.supported_parameters?.includes("tools")
                  ? (["tools"] as const)
                  : []),
                ...(m.supported_parameters?.includes("reasoning")
                  ? (["reasoning"] as const)
                  : []),
              ]),
            ] as ModelCapability[],
            limits: {
              contextWindow: m.context_length ?? 0,
              maxOutputTokens: m.top_provider.max_completion_tokens || null,
            },
            costs: {
              input: m.pricing.prompt ?? 0,
              output: m.pricing.completion ?? 0,
            },
          };
        };

        // v1 is the authoritative source — has supported_parameters, canonical slugs, etc.
        const res = await fetch("https://openrouter.ai/api/v1/models", {
          headers,
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok)
          throw new Error(`OpenRouter listModels failed: ${res.status}`);
        const { data }: { data: OpenRouterAPIModel[] } = await res.json();
        const models = data.map(mapV1Model);

        // Best-effort: use frontend popular order for sorting. Falls back to v1 default order.
        // try {
        //   const frontendRes = await fetch(
        //     "https://openrouter.ai/api/frontend/models/find?order=most-popular",
        //     { signal: AbortSignal.timeout(10_000) },
        //   );
        //   if (frontendRes.ok) {
        //     const frontendData = await frontendRes.json();
        //     const slugOrder = new Map<string, number>(
        //       (frontendData.data?.models as { slug: string }[] ?? []).map(
        //         (m, i) => [m.slug, i] as const,
        //       ),
        //     );
        //     if (slugOrder.size > 0) {
        //       models.sort(
        //         (a, b) =>
        //           (slugOrder.get(a.modelId) ?? Infinity) -
        //           (slugOrder.get(b.modelId) ?? Infinity),
        //       );
        //     }
        //   }
        // } catch { /* best-effort — v1 order is fine */ }

        return models;
      },
    };
  },
};
