import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { resolveOriginTokenEndpoint } from "./resolve-token-endpoint";

const originalFetch = globalThis.fetch;

const installFetch = (responder: () => Response | Promise<Response>): void => {
  globalThis.fetch = (async () =>
    await responder()) as unknown as typeof globalThis.fetch;
};

describe("resolveOriginTokenEndpoint", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns a well-formed http(s) token_endpoint", async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({ token_endpoint: "https://idp.example.com/token" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    const result = await resolveOriginTokenEndpoint("https://mcp.example.com");
    expect(result).toBe("https://idp.example.com/token");
  });

  it("rejects a non-http(s) token_endpoint instead of handing it back", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ token_endpoint: "file:///etc/passwd" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await resolveOriginTokenEndpoint("https://mcp.example.com");
    expect(result).toBeNull();
  });

  it("rejects a non-string token_endpoint instead of handing it back", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ token_endpoint: 12345 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await resolveOriginTokenEndpoint("https://mcp.example.com");
    expect(result).toBeNull();
  });
});
