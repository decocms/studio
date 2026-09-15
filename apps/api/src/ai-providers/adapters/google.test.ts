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
        models: [{ name: "models/gemini-a", supportedGenerationMethods: [] }],
        nextPageToken: "page-2",
      },
      "page-2": {
        models: [{ name: "models/gemini-b", supportedGenerationMethods: [] }],
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
});
