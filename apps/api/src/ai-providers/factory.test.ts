import { afterEach, describe, expect, test } from "bun:test";
import type { AIProviderKeyStorage } from "../storage/ai-provider-keys";
import { AIProviderFactory } from "./factory";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const GOOGLE_MODELS_BODY = {
  models: [
    {
      name: "models/gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      version: "1",
      inputTokenLimit: 100,
      outputTokenLimit: 10,
      supportedGenerationMethods: ["generateContent"],
      thinking: false,
      temperature: 1,
      maxTemperature: 1,
      description: "d",
      topP: 1,
      topK: 1,
    },
  ],
};

// OpenRouter omits `supported_parameters` for some models.
const OPENROUTER_MODELS_BODY = {
  data: [
    {
      id: "google/gemini-2.5-flash",
      canonical_slug: "google/gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      created: 0,
      // OpenRouter serializes pricing as decimal strings, not numbers.
      pricing: {
        prompt: "0.0000005808",
        completion: "0.0000017424",
        request: "0",
        image: "0",
      },
      context_length: 100,
      architecture: {
        modality: "text",
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        tokenizer: "x",
      },
      top_provider: {
        is_moderated: false,
        context_length: 100,
        max_completion_tokens: 10,
      },
      description: "d",
    },
  ],
};

function fakeStorage(): AIProviderKeyStorage {
  return {
    resolve: async () => ({
      keyInfo: { id: "key-1", providerId: "google" } as never,
      apiKey: "secret",
    }),
  } as unknown as AIProviderKeyStorage;
}

describe("AIProviderFactory.listModels", () => {
  test("enriches from OpenRouter even when a model omits supported_parameters", async () => {
    globalThis.fetch = (async (url: unknown): Promise<Response> => {
      const u = String(url);
      const parsed = new URL(u);
      if (parsed.hostname === "generativelanguage.googleapis.com") {
        return new Response(JSON.stringify(GOOGLE_MODELS_BODY), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        parsed.hostname === "openrouter.ai" &&
        parsed.pathname === "/api/v1/models"
      ) {
        return new Response(JSON.stringify(OPENROUTER_MODELS_BODY), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const factory = new AIProviderFactory(fakeStorage());
    const models = await factory.listModels("key-1", "org-1");

    expect(models).toHaveLength(1);
    // Regression: this model previously crashed index-building, blanking enrichment.
    expect(models[0]?.capabilities).toContain("vision");
    // Regression: OpenRouter's decimal-string pricing must be parsed to numbers.
    expect(models[0]?.costs?.input).toBe(0.0000005808);
    expect(models[0]?.costs?.output).toBe(0.0000017424);
  });
});
