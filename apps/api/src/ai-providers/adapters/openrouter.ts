import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  fetchWithTransientRetry,
  throwResponseError,
} from "./fetch-transient-retry";
import { deriveModalityCapabilities } from "./model-capabilities";
import type {
  StudioProvider,
  ModelInfo,
  OAuthPkceResult,
  OpenRouterAPIModel,
  ProviderAdapter,
} from "../types";
const OPENROUTER_ICON_URL =
  "https://assets.decocache.com/decocms/284f1ad9-3fd8-494c-be88-16671069f3b9/openrouter.svg";

/**
 * Parse a 2xx response body as JSON, degrading a malformed body into a
 * labeled error instead of a bare SyntaxError with no request context.
 */
async function parseJsonResponse<T>(label: string, res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} returned malformed JSON: ${text.slice(0, 200)}`);
  }
}

function fetchModelsWithRetry(
  headers: Record<string, string>,
  decisions = false,
): Promise<Response> {
  return fetchWithTransientRetry(
    "OpenRouter listModels",
    decisions
      ? "https://openrouter.ai/api/v1/models?output_modalities=decisions"
      : "https://openrouter.ai/api/v1/models",
    { headers, signal: AbortSignal.timeout(decisions ? 5_000 : 30_000) },
  );
}

/**
 * OpenRouter's catalog occasionally lists a model missing the nested
 * metadata mapV1Model relies on — skip it instead of crashing the whole
 * listModels call over one bad entry.
 */
function isMappableModel(m: OpenRouterAPIModel): boolean {
  return (
    typeof m.id === "string" &&
    !!m.architecture &&
    Array.isArray(m.architecture.input_modalities) &&
    Array.isArray(m.architecture.output_modalities) &&
    !!m.top_provider &&
    !!m.pricing
  );
}

function mapV1Model(m: OpenRouterAPIModel): ModelInfo {
  const contextWindow = m.context_length ?? 0;
  const reportedMaxOut = m.top_provider.max_completion_tokens || null;
  const maxOutputTokens =
    reportedMaxOut && (contextWindow === 0 || reportedMaxOut < contextWindow)
      ? reportedMaxOut
      : null;
  return {
    providerId: "openrouter",
    modelId: m.id,
    title: m.name,
    description: m.description ?? null,
    logo: null,
    capabilities: deriveModalityCapabilities(
      m.architecture.input_modalities,
      m.architecture.output_modalities,
      m.supported_parameters,
      m.supported_parameters?.includes("reasoning") ? ["reasoning"] : [],
    ),
    limits: {
      contextWindow,
      maxOutputTokens,
    },
    costs: {
      input: Number(m.pricing.prompt) || 0,
      output: Number(m.pricing.completion) || 0,
    },
  };
}

export const openrouterAdapter: ProviderAdapter = {
  info: {
    id: "openrouter",
    name: "OpenRouter",
    description: "One account, hundreds of AI models",
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
      await throwResponseError("OpenRouter OAuth exchange", res);
    }
    const data = await parseJsonResponse<{ key?: string; user_id?: string }>(
      "OpenRouter OAuth exchange",
      res,
    );
    if (typeof data.key !== "string" || !data.key) {
      throw new Error(
        "OpenRouter OAuth exchange returned a malformed response (missing key)",
      );
    }
    return { apiKey: data.key, userId: data.user_id };
  },

  create(apiKey): StudioProvider {
    const aiSdk = createOpenRouter({
      apiKey,
    });

    const headers = { Authorization: `Bearer ${apiKey}` };

    return {
      info: this.info,
      aiSdk,
      decisions: {
        model: (modelId) => aiSdk.evaluationModel(modelId),
        async listModels() {
          const res = await fetchModelsWithRetry(headers, true);
          if (!res.ok)
            await throwResponseError("OpenRouter decision models", res);
          const { data } = await parseJsonResponse<{
            data: OpenRouterAPIModel[];
          }>("OpenRouter decision models", res);
          return data
            .filter(isMappableModel)
            .filter((model) =>
              model.architecture.output_modalities.includes("decisions"),
            )
            .map(mapV1Model);
        },
      },

      async listModels(): Promise<ModelInfo[]> {
        // v1 is the authoritative source — has supported_parameters, canonical slugs, etc.
        const res = await fetchModelsWithRetry(headers);
        if (!res.ok) await throwResponseError("OpenRouter listModels", res);
        const { data } = await parseJsonResponse<{
          data: OpenRouterAPIModel[];
        }>("OpenRouter listModels", res);
        return data.filter(isMappableModel).map(mapV1Model);
      },
    };
  },
};
