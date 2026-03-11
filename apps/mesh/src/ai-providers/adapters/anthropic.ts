import { createAnthropic } from "@ai-sdk/anthropic";
import { Anthropic } from "@anthropic-ai/sdk";
import type {
  MeshProvider,
  ProviderAdapter,
  TokenCounter,
  ModelInfo,
} from "../types";

export const anthropicAdapter: ProviderAdapter = {
  info: {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude language models",
    logo: "https://anthropic.com/favicon.ico",
  },

  supportedMethods: ["api-key"],

  create(apiKey): MeshProvider & TokenCounter {
    const aiSdk = createAnthropic({ apiKey });
    const nativeClient = new Anthropic({ apiKey });

    return {
      info: this.info,
      aiSdk,

      async listModels(): Promise<ModelInfo[]> {
        const res = await nativeClient.models.list();
        return res.data.map((m: { id: string; display_name: string }) => ({
          modelId: m.id,
          title: m.display_name,
          description: null,
          logo: null,
          capabilities:
            m.id.includes("claude-3") || m.id.includes("claude-4")
              ? ["text", "vision"]
              : ["text"],
          limits: null,
          costs: null,
        }));
      },

      async countTokens({ messages, modelId }) {
        const res = await nativeClient.messages.countTokens({
          messages: messages as Parameters<
            typeof nativeClient.messages.countTokens
          >[0]["messages"],
          model: modelId,
        });
        return { count: res.input_tokens };
      },
    };
  },
};
