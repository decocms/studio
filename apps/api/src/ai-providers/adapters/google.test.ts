import { afterEach, describe, expect, test } from "bun:test";
import { googleAdapter } from "./google";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("googleAdapter.listModels", () => {
  test("sends the API key via header, never in the URL", async () => {
    let capturedUrl = "";
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = (async (
      url: unknown,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = String(url);
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = googleAdapter.create("secret-api-key");
    await provider.listModels();

    // The key must never land in the URL: outbound fetches are OTel-traced
    // with the full URL (including query string), so a `?key=` param would
    // leak the credential into every trace span.
    expect(capturedUrl).not.toContain("secret-api-key");
    expect(capturedHeaders?.get("x-goog-api-key")).toBe("secret-api-key");
  });

  test("bounds the request with a timeout, like every other adapter", async () => {
    let capturedSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (
      _url: unknown,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedSignal = init?.signal;
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = googleAdapter.create("secret-api-key");
    await provider.listModels();

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  test("follows nextPageToken instead of truncating the catalog", async () => {
    const pages: Record<string, unknown> = {
      "": {
        models: [
          {
            name: "models/gemini-a",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
        nextPageToken: "page-2",
      },
      "page-2": {
        models: [
          {
            name: "models/gemini-b",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      },
    };
    const requestedTokens: string[] = [];
    globalThis.fetch = (async (url: unknown): Promise<Response> => {
      const token = new URL(String(url)).searchParams.get("pageToken") ?? "";
      requestedTokens.push(token);
      return new Response(JSON.stringify(pages[token]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = googleAdapter.create("secret-api-key");
    const models = await provider.listModels();

    expect(requestedTokens).toEqual(["", "page-2"]);
    expect(models.map((m) => m.modelId)).toEqual(["gemini-a", "gemini-b"]);
  });

  test("retries a transient 5xx and succeeds once Google recovers", async () => {
    let calls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      calls++;
      if (calls < 3) {
        return new Response("upstream hiccup", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          models: [
            {
              name: "models/gemini-a",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const provider = googleAdapter.create("secret-api-key");
    const models = await provider.listModels();

    expect(calls).toBe(3);
    expect(models.map((m) => m.modelId)).toEqual(["gemini-a"]);
  });

  test("does not retry a non-transient 4xx and surfaces it immediately", async () => {
    let calls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      calls++;
      return new Response("bad key", { status: 401 });
    }) as unknown as typeof fetch;

    const provider = googleAdapter.create("bad-key");

    await expect(provider.listModels()).rejects.toThrow(
      "Google listModels failed: 401",
    );
    expect(calls).toBe(1);
  });

  test("drops embedding/AQA models but keeps chat, image, and research models", async () => {
    globalThis.fetch = (async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          models: [
            {
              name: "models/gemini-2.5-flash",
              displayName: "Gemini 2.5 Flash",
              supportedGenerationMethods: ["generateContent"],
            },
            {
              name: "models/text-embedding-004",
              displayName: "Text Embedding 004",
              supportedGenerationMethods: ["embedContent"],
            },
            {
              name: "models/aqa",
              displayName: "Model for AQA",
              supportedGenerationMethods: ["generateAnswer"],
            },
            {
              name: "models/imagen-3.0-generate-002",
              displayName: "Imagen 3",
              supportedGenerationMethods: ["predict"],
            },
            {
              name: "models/deep-research-preview-04-2026",
              displayName: "Deep Research",
              supportedGenerationMethods: ["generateAnswer"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const provider = googleAdapter.create("secret-api-key");
    const models = await provider.listModels();

    expect(models.map((m) => m.modelId)).toEqual([
      "gemini-2.5-flash",
      "imagen-3.0-generate-002",
      "deep-research-preview-04-2026",
    ]);
  });
});
