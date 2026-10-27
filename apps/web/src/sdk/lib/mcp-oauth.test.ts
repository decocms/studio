import { describe, expect, test, afterEach } from "bun:test";
import {
  isConnectionAuthenticated,
  buildAuthorizationHeaderValue,
} from "./mcp-oauth";

describe("buildAuthorizationHeaderValue", () => {
  test("defaults to Bearer for a plain token", () => {
    expect(buildAuthorizationHeaderValue("abc123")).toBe("Bearer abc123");
  });

  test("sends a full scheme verbatim when the token already has one", () => {
    expect(buildAuthorizationHeaderValue("Token token=abc123")).toBe(
      "Token token=abc123",
    );
  });

  test("trims surrounding whitespace", () => {
    expect(buildAuthorizationHeaderValue("  abc123  ")).toBe("Bearer abc123");
  });
});

describe("isConnectionAuthenticated", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("surfaces a clear message when the probe times out", async () => {
    global.fetch = (() =>
      Promise.reject(
        new DOMException("The operation timed out.", "TimeoutError"),
      )) as unknown as typeof fetch;

    const result = await isConnectionAuthenticated({
      url: "https://example.com/api/my-org/mcp/conn-1",
      token: null,
    });

    expect(result.isAuthenticated).toBe(false);
    expect(result.error).toBe("Connection check timed out after 15s");
  });

  test("reads a sandbox sign-in connection's status from its stored token, without probing it", async () => {
    const requested: string[] = [];
    const status = (body: object) =>
      (async (input: RequestInfo | URL) => {
        requested.push(String(input));
        return Response.json(body);
      }) as unknown as typeof fetch;
    const check = () =>
      isConnectionAuthenticated({
        url: "https://example.com/api/my-org/mcp/conn-1",
        token: null,
      });

    global.fetch = status({
      sandboxSignIn: true,
      hasToken: true,
      isExpired: true,
      canRefresh: true,
    });
    expect(await check()).toEqual({
      isAuthenticated: true,
      supportsOAuth: true,
      hasOAuthToken: true,
    });

    global.fetch = status({
      sandboxSignIn: true,
      hasToken: true,
      isExpired: true,
      canRefresh: false,
    });
    expect((await check()).isAuthenticated).toBe(false);

    global.fetch = status({
      sandboxSignIn: true,
      hasToken: false,
      isExpired: true,
      canRefresh: false,
    });
    expect(await check()).toEqual({
      isAuthenticated: false,
      supportsOAuth: true,
      hasOAuthToken: false,
    });

    expect(requested.every((url) => url.endsWith("/oauth-token/status"))).toBe(
      true,
    );
  });
});
