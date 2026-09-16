import { afterEach, describe, expect, test } from "bun:test";
import { llmapiAdapter } from "./llmapi";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const MODELS_BODY = {
  data: [
    {
      id: "openai/gpt-4",
      name: "GPT-4",
      description: "d",
      context_length: 8192,
      pricing: { prompt: "0.00001", completion: "0.00003" },
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["tools"],
    },
  ],
};

describe("llmapiAdapter.listModels", () => {
  test("retries a transient 5xx and succeeds once LLMAPI recovers", async () => {
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

    const provider = llmapiAdapter.create("secret-key");
    const models = await provider.listModels();

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

    const provider = llmapiAdapter.create("bad-key");

    await expect(provider.listModels()).rejects.toThrow(
      "LLMAPI listModels failed: 401",
    );
    expect(calls).toBe(1);
  });
});
