import { createOpenAI } from "@ai-sdk/openai";
import type { ModelCapability } from "@decocms/shared/sdk";
import type {
  StudioProvider,
  ModelInfo,
  OrcaRouterAPIModel,
  ProviderAdapter,
} from "../types";

const ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";
const ORCAROUTER_ICON_URL =
  "https://mintcdn.com/orcarouter/8cZaZ6XJV6FJz0EN/images/logo.png";

export const orcarouterAdapter: ProviderAdapter = {
  info: {
    id: "orcarouter",
    name: "OrcaRouter",
    description: "One API, multi-provider, zero markup",
    logo: ORCAROUTER_ICON_URL,
  },

  supportedMethods: ["api-key"],

  create(apiKey): StudioProvider {
    const openai = createOpenAI({
      baseURL: ORCAROUTER_BASE_URL,
      apiKey: apiKey || "not-needed",
      name: "orcarouter",
    });

    // Wrap so that languageModel() uses the chat completions API
    // (/v1/chat/completions) instead of the OpenAI Responses API (/responses)
    // which most compatible servers don't support.
    const aiSdk: typeof openai = Object.assign(
      (...args: Parameters<typeof openai>) => openai.chat(...args),
      openai,
      { languageModel: openai.chat },
    );

    return {
      info: this.info,
      aiSdk,

      async listModels(): Promise<ModelInfo[]> {
        const mapModel = (m: OrcaRouterAPIModel): ModelInfo => {
          const contextWindow =
            m.context_length ?? m.top_provider?.context_length ?? 0;
          const reportedMaxOut =
            m.max_completion_tokens ??
            m.top_provider?.max_completion_tokens ??
            null;
          const maxOutputTokens =
            reportedMaxOut &&
            (contextWindow === 0 || reportedMaxOut < contextWindow)
              ? reportedMaxOut
              : null;

          return {
            providerId: "orcarouter",
            modelId: m.id,
            title: m.name || m.id,
            description: m.description ?? null,
            logo: null,
            capabilities: [
              ...new Set([
                // OrcaRouter uses "image" in input_modalities to mean vision (can see images).
                // Map it to "vision" so we distinguish from "image" (image generation output).
                ...(m.architecture?.input_modalities ?? []).map((mod) =>
                  mod === "image" ? "vision" : mod,
                ),
                ...(m.architecture?.output_modalities ?? []),
              ]),
            ] as ModelCapability[],
            limits: {
              contextWindow,
              maxOutputTokens,
            },
            costs: m.pricing
              ? {
                  input: Number(m.pricing.prompt) || 0,
                  output: Number(m.pricing.completion) || 0,
                }
              : null,
          };
        };

        const headers: Record<string, string> = {};
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

        const res = await fetch(`${ORCAROUTER_BASE_URL}/models`, {
          headers,
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          throw new Error(`OrcaRouter listModels failed: ${res.status}`);
        }
        const { data }: { data: OrcaRouterAPIModel[] } = await res.json();
        const models = data.map(mapModel);

        return models;
      },
    };
  },
};
