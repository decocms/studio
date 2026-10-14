import { createAnthropic } from "@ai-sdk/anthropic";
import { Anthropic } from "@anthropic-ai/sdk";
import type {
  StudioProvider,
  ProviderAdapter,
  TokenCounter,
  ModelInfo,
} from "../types";

export const anthropicAdapter: ProviderAdapter = {
  info: {
    id: "anthropic",
    name: "Anthropic",
    description: "Anthropic's Claude family of models",
    logo: "https://assets.decocache.com/decocms/51a209ae-14bc-4b6f-8216-8eb670695bd7/Anthropic-Icon--Streamline-Svg-Logos.svg",
  },

  supportedMethods: ["api-key"],

  create(apiKey): StudioProvider & TokenCounter {
    const aiSdk = createAnthropic({ apiKey });
    const nativeClient = new Anthropic({ apiKey });

    return {
      info: this.info,
      aiSdk,

      async listModels(): Promise<ModelInfo[]> {
        const models: ModelInfo[] = [];
        // follow every page, not just the first (the API paginates at 20/page)
        for await (const m of nativeClient.models.list()) {
          models.push({
            modelId: m.id,
            providerId: "anthropic",
            title: m.display_name,
            description: null,
            logo: null,
            capabilities: [],
            limits: null,
            costs: null,
          });
        }
        return models;
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
