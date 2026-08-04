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
});
