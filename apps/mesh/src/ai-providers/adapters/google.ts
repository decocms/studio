import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { ModelCapability } from "@decocms/mesh-sdk";
import {
  isInteractionsOnlyModel,
  pollInteraction,
  submitInteraction,
} from "./gemini-interactions";
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
  /** Lifecycle stage returned by the API (e.g. "ACTIVE", "DEPRECATED"). */
  lifecycleState?: string;
}

/**
 * Derive capabilities from the Google model metadata.
 *
 * Only tags dedicated image-generation models (Imagen, Gemini *-image variants).
 * Multimodal language models (gemini-2.5-flash etc.) return [] so the
 * OpenRouter enrichment in factory.ts fills in their full capability set
 * (with the correct image→vision remapping for input modalities).
 */
function deriveCapabilities(m: GoogleModel): ModelCapability[] {
  const id = m.name.replace("models/", "");

  // Dedicated image generation models: Imagen family or Gemini image variants
  if (/^imagen-/.test(id) || /-image/.test(id)) {
    const caps: ModelCapability[] = ["image"];
    // Gemini image models also support text in/out via generateContent
    if (m.supportedGenerationMethods.includes("generateContent")) {
      caps.push("text");
    }
    return caps;
  }

  // Everything else: let OpenRouter enrichment handle capabilities
  return [];
}

export const googleAdapter: ProviderAdapter = {
  info: {
    id: "google",
    name: "Google",
    description: "Google language models",
    logo: "https://assets.decocache.com/decocms/29370b4b-c623-487b-a6c4-a1637a2c0401/Google__G__logo.svg",
  },

  supportedMethods: ["api-key"],

  create(apiKey): MeshProvider {
    const aiSdk = createGoogleGenerativeAI({ apiKey });

    return {
      info: this.info,
      aiSdk,

      asyncResearch: {
        canHandle: (modelId) => isInteractionsOnlyModel(modelId),
        start: async ({ modelId, query, abortSignal }) => {
          const { interactionId } = await submitInteraction({
            apiKey,
            agent: modelId,
            query,
            abortSignal,
          });
          return { jobId: interactionId };
        },
        resume: ({ jobId, abortSignal, onProgress, pollIntervalMs }) =>
          pollInteraction({
            apiKey,
            interactionId: jobId,
            abortSignal,
            onProgress,
            pollIntervalMs,
          }),
      },

      async listModels(): Promise<ModelInfo[]> {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        );
        if (!res.ok) {
          throw new Error(`Google listModels failed: ${res.status}`);
        }
        const data: { models: GoogleModel[] } = await res.json();
        return data.models
          .filter((m: GoogleModel) => m.lifecycleState !== "DEPRECATED")
          .map((m: GoogleModel) => {
            const id = m.name.replace("models/", "");
            return {
              modelId: id,
              providerId: "google" as const,
              title: m.displayName,
              description: m.description,
              logo: null,
              capabilities: deriveCapabilities(m),
              limits: {
                contextWindow: m.inputTokenLimit,
                maxOutputTokens: m.outputTokenLimit,
              },
              costs: null,
              ...(isInteractionsOnlyModel(id) && { asyncResearch: true }),
            };
          });
      },
    };
  },
};
