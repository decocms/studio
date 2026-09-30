import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { resolveOriginTokenEndpoint } from "./resolve-token-endpoint";

const originalFetch = globalThis.fetch;

const installFetch = (responder: () => Response | Promise<Response>): void => {
  globalThis.fetch = (async () =>
    await responder()) as unknown as typeof globalThis.fetch;
};

const mockDnsLookup = (address: string): void => {
  mock.module("node:dns/promises", () => ({
    lookup: async () => [{ address, family: 4 }],
  }));
};

describe("resolveOriginTokenEndpoint", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    mockDnsLookup("93.184.216.34");
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

  it("rejects a private/internal token_endpoint instead of handing it back", async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({ token_endpoint: "http://169.254.169.254/token" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );

    const result = await resolveOriginTokenEndpoint("https://mcp.example.com");
    expect(result).toBeNull();
  });

  it("rejects a token_endpoint whose domain resolves to a private address", async () => {
    mockDnsLookup("169.254.169.254");

    installFetch(
      () =>
        new Response(
          JSON.stringify({ token_endpoint: "https://idp.evil.example/token" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
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

  it("drains every discarded metadata response body on failure", async () => {
    const responses: Response[] = [];
    globalThis.fetch = (async () => {
      const res = new Response(JSON.stringify({}), { status: 500 });
      responses.push(res);
      return res;
    }) as unknown as typeof globalThis.fetch;

    const result = await resolveOriginTokenEndpoint("https://mcp.example.com");

    expect(result).toBeNull();
    expect(responses.length).toBeGreaterThan(0);
    expect(responses.every((res) => res.bodyUsed)).toBe(true);
  });
});
