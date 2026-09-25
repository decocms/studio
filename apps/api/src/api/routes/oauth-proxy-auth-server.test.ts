import { describe, it, expect, afterEach } from "bun:test";
import { getOriginAuthServer } from "./oauth-proxy";

const originalFetch = globalThis.fetch;

describe("getOriginAuthServer", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns a string authorization_servers entry", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          authorization_servers: ["https://idp.example.com"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof globalThis.fetch;

    const result = await getOriginAuthServer("https://mcp.example.com/sse");
    expect(result).toBe("https://idp.example.com");
  });

  it("falls back to the origin root on a non-string authorization_servers entry", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ authorization_servers: [12345] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    const result = await getOriginAuthServer("https://mcp.example.com/sse");
    expect(result).toBe("https://mcp.example.com");
  });

  it("falls back to the origin root when authorization_servers is missing", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    const result = await getOriginAuthServer("https://mcp.example.com/sse");
    expect(result).toBe("https://mcp.example.com");
  });
});
