import { describe, it, expect, afterEach } from "bun:test";
import { firstAuthorizationServer, getOriginAuthServer } from "./oauth-proxy";

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

describe("firstAuthorizationServer", () => {
  it("returns a string entry", () => {
    expect(
      firstAuthorizationServer({
        authorization_servers: ["https://idp.example.com"],
      }),
    ).toBe("https://idp.example.com");
  });

  it("rejects a non-string entry", () => {
    expect(
      firstAuthorizationServer({ authorization_servers: [12345] }),
    ).toBeUndefined();
  });

  it("rejects a non-array authorization_servers", () => {
    expect(
      firstAuthorizationServer({
        authorization_servers: "https://idp.example.com",
      }),
    ).toBeUndefined();
  });

  it("handles missing or malformed data", () => {
    expect(firstAuthorizationServer({})).toBeUndefined();
    expect(firstAuthorizationServer(null)).toBeUndefined();
    expect(firstAuthorizationServer(undefined)).toBeUndefined();
  });
});
