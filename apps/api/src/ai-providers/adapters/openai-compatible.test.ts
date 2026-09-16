import { afterEach, describe, expect, test } from "bun:test";
import { openaiCompatibleAdapter } from "./openai-compatible";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const CREDENTIAL = JSON.stringify({
  baseUrl: "https://my-endpoint.example.com/v1",
  apiKey: "secret-key",
});

const MODELS_BODY = {
  data: [{ id: "llama-3", owned_by: "meta" }],
};

describe("openaiCompatibleAdapter.listModels", () => {
  test("retries a transient 5xx and succeeds once the endpoint recovers", async () => {
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

    const provider = openaiCompatibleAdapter.create(CREDENTIAL);
    const models = await provider.listModels?.();

    expect(calls).toBe(3);
    expect(models).toHaveLength(1);
    expect(models?.[0]?.modelId).toBe("llama-3");
  });

  test("does not retry a non-transient 4xx and surfaces it immediately", async () => {
    let calls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      calls++;
      return new Response("bad key", { status: 401 });
    }) as unknown as typeof fetch;

    const provider = openaiCompatibleAdapter.create(CREDENTIAL);

    await expect(provider.listModels?.()).rejects.toThrow(
      "OpenAI-compatible listModels failed: 401",
    );
    expect(calls).toBe(1);
  });
});
