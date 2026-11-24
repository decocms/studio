import { describe, it, expect, afterEach } from "bun:test";
import { firstAuthorizationServer, getOriginAuthServer } from "./oauth-proxy";

const originalFetch = globalThis.fetch;

// Discovery resolves DNS before fetching; a public IP literal skips the lookup
// so these stay offline.
const ORIGIN = "https://203.0.113.10";
const ORIGIN_URL = `${ORIGIN}/sse`;

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

    const result = await getOriginAuthServer(ORIGIN_URL);
    expect(result).toBe("https://idp.example.com");
  });

  it("falls back to the origin root on a non-string authorization_servers entry", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ authorization_servers: [12345] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    const result = await getOriginAuthServer(ORIGIN_URL);
    expect(result).toBe(ORIGIN);
  });

  it("falls back to the origin root when authorization_servers is missing", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    const result = await getOriginAuthServer(ORIGIN_URL);
    expect(result).toBe(ORIGIN);
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
