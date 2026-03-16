import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { MeshProvider, ProviderAdapter, ModelInfo } from "../types";

interface GoogleModel {
  baseModelId: string;
  name: string;
  displayName: string;
  version: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  supportedGenerationMethods: string[];
  thinking: boolean;
  temperature: number;
  maxTemperature: number;
  description: string;
  topP: number;
  topK: number;
}

export const googleAdapter: ProviderAdapter = {
  info: {
    id: "google",
    name: "Google",
    description: "Google language models",
    logo: "https://google.com/favicon.ico",
  },

  supportedMethods: ["api-key"],

  create(apiKey): MeshProvider {
    const aiSdk = createGoogleGenerativeAI({ apiKey });

    return {
      info: this.info,
      aiSdk,

      async listModels(): Promise<ModelInfo[]> {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        );
        if (!res.ok) {
          throw new Error(`Google listModels failed: ${res.status}`);
        }
        const data: { models: GoogleModel[] } = await res.json();
        return data.models.map((m: GoogleModel) => ({
          modelId: m.name.replace("models/", ""),
          providerId: "google",
          title: m.displayName,
          description: m.description,
          logo: null,
          capabilities: [],
          limits: {
            contextWindow: m.inputTokenLimit,
            maxOutputTokens: m.outputTokenLimit,
          },
          costs: null,
        }));
      },
    };
  },
};
