import { createOpenAI } from "@ai-sdk/openai";
import type { ModelCapability } from "@decocms/shared/sdk";
import type { StudioProvider, ModelInfo, ProviderAdapter } from "../types";

const LLMAPI_BASE_URL = "https://api.llmapi.ai/v1";
const LLMAPI_ICON_URL =
  "https://llmapi.ai/wp-content/uploads/2026/01/Frame-2085662993.png";

// Shape of an entry in llmapi's OpenRouter-style /v1/models payload. Only the
// fields we read — the endpoint returns much more (per-provider routing, etc).
interface LlmapiModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[] | null;
  reasoning_levels?: unknown[];
  providers?: { reasoning?: boolean }[];
}

export const llmapiAdapter: ProviderAdapter = {
  info: {
    id: "llmapi",
    name: "LLMAPI",
    description: "One API key, 400+ models across every provider",
    logo: LLMAPI_ICON_URL,
  },

  supportedMethods: ["api-key"],

  create(apiKey): StudioProvider {
    const openai = createOpenAI({
      apiKey: apiKey || "not-needed",
      baseURL: LLMAPI_BASE_URL,
      name: "llmapi",
    });

    // Route languageModel() through /chat/completions (llmapi doesn't serve the
    // OpenAI Responses API). Same wrapper the openai-compatible adapter uses.
    const aiSdk: typeof openai = Object.assign(
      (...args: Parameters<typeof openai>) => openai.chat(...args),
      openai,
      { languageModel: openai.chat },
    );

    return {
      info: this.info,
      aiSdk,

      async listModels(): Promise<ModelInfo[]> {
        const res = await fetch(`${LLMAPI_BASE_URL}/models`, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          throw new Error(`LLMAPI listModels failed: ${res.status}`);
        }
        const { data }: { data: LlmapiModel[] } = await res.json();
        return data.map((m) => {
          const arch = m.architecture ?? {};
          const canReason =
            !!m.reasoning_levels?.length ||
            !!m.providers?.some((p) => p.reasoning);
          return {
            providerId: "llmapi",
            modelId: m.id,
            title: m.name || m.id,
            description: m.description ?? null,
            logo: null,
            capabilities: [
              ...new Set([
                // "image" in input means vision (accepts images), not image
                // generation — remap so it's distinct from output "image".
                ...(arch.input_modalities ?? []).map((mod) =>
                  mod === "image" ? "vision" : mod,
                ),
                ...(arch.output_modalities ?? []),
                ...(m.supported_parameters?.includes("tools")
                  ? (["tools"] as const)
                  : []),
                ...(canReason ? (["reasoning"] as const) : []),
              ]),
            ] as ModelCapability[],
            limits: {
              contextWindow: m.context_length ?? 0,
              maxOutputTokens: null,
            },
            costs: {
              input: Number(m.pricing?.prompt) || 0,
              output: Number(m.pricing?.completion) || 0,
            },
          };
        });
      },
    };
  },
};
