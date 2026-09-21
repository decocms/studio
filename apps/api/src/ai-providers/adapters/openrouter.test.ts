import { afterEach, describe, expect, test } from "bun:test";
import { openrouterAdapter } from "./openrouter";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const MODELS_BODY = {
  data: [
    {
      id: "openai/gpt-4",
      canonical_slug: "openai/gpt-4",
      name: "GPT-4",
      created: 0,
      pricing: {
        prompt: "0.00001",
        completion: "0.00003",
        request: "0",
        image: "0",
      },
      context_length: 8192,
      architecture: {
        modality: "text",
        input_modalities: ["text"],
        output_modalities: ["text"],
        tokenizer: "x",
      },
      top_provider: {
        is_moderated: false,
        context_length: 8192,
        max_completion_tokens: 4096,
      },
      description: "d",
    },
  ],
};

describe("openrouterAdapter.listModels", () => {
  test("retries a transient 5xx and succeeds once OpenRouter recovers", async () => {
    let calls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      calls++;
      if (calls < 3) {
        return new Response("upstream hiccup", { status: 503 });
      }
      return new Response(JSON.stringify(MODELS_BODY), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = openrouterAdapter.create("secret-key");
    const models = await provider.listModels();

    // Only the three chat-catalog attempts; Decisions must stay lazy.
    expect(calls).toBe(3);
    expect(models).toHaveLength(1);
    expect(models[0]?.modelId).toBe("openai/gpt-4");
  });

  test("does not retry a non-transient 4xx and surfaces it immediately", async () => {
    let calls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      calls++;
      return new Response("bad key", { status: 401 });
    }) as unknown as typeof fetch;

    const provider = openrouterAdapter.create("bad-key");

    await expect(provider.listModels()).rejects.toThrow(
      "OpenRouter listModels failed: 401",
    );
    expect(calls).toBe(1);
  });
});
