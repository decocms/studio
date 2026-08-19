import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { refreshAccessToken } from "./refresh-access-token";
import type { DownstreamToken } from "../storage/types";

const baseToken: DownstreamToken = {
  id: "dtok_test",
  connectionId: "conn_test",
  userId: null,
  accessToken: "stale",
  refreshToken: "rt",
  scope: "repo",
  expiresAt: new Date(Date.now() - 1000),
  createdAt: new Date(),
  updatedAt: new Date(),
  clientId: "cid",
  clientSecret: null,
  tokenEndpoint: "https://example.com/token",
};

const originalFetch = globalThis.fetch;

const installFetch = (responder: () => Response | Promise<Response>): void => {
  globalThis.fetch = (async () =>
    await responder()) as unknown as typeof globalThis.fetch;
};

describe("refreshAccessToken", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("flags 400 invalid_grant as permanent so callers can delete the token", async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "refresh token revoked",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await refreshAccessToken(baseToken);

    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.error).toContain("revoked");
  });

  it("flags 400 bad_refresh_token as permanent (non-standard GitHub MCP code)", async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "bad_refresh_token",
            error_description:
              "The refresh token passed is incorrect or expired.",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await refreshAccessToken(baseToken);

    expect(result.success).toBe(false);
    expect(result.permanent).toBe(true);
  });

  it("ignores a non-string error/error_description instead of leaking them onto the result", async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({ error: 400, error_description: { code: 400 } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await refreshAccessToken(baseToken);

    expect(result.success).toBe(false);
    expect(result.permanent).toBe(false);
    expect(result.errorCode).toBeUndefined();
    expect(result.error).toBe("Token refresh failed: 400");
  });

  it("flags other 4xx errors as transient (could be config issue, retry-worthy)", async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "invalid_request",
            error_description: "missing parameter",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await refreshAccessToken(baseToken);

    expect(result.success).toBe(false);
    expect(result.permanent).toBe(false);
  });

  it("flags 5xx as transient — the OAuth server is broken, the token might still be valid", async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "server_error",
            error_description: "Failed to process token request",
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await refreshAccessToken(baseToken);

    expect(result.success).toBe(false);
    expect(result.permanent).toBe(false);
  });

  it("flags network errors as transient", async () => {
    installFetch(() => {
      throw new Error("network down");
    });

    const result = await refreshAccessToken(baseToken);

    expect(result.success).toBe(false);
    expect(result.permanent).toBe(false);
  });

  it("flags missing prerequisites as transient (config bug, not a bad refresh_token)", async () => {
    const noRefreshToken = { ...baseToken, refreshToken: null };
    const result = await refreshAccessToken(noRefreshToken);

    expect(result.success).toBe(false);
    expect(result.permanent).toBe(false);
  });

  it("does not flag success results as permanent", async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            access_token: "new",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await refreshAccessToken(baseToken);

    expect(result.success).toBe(true);
    expect(result.permanent).toBeUndefined();
    expect(result.accessToken).toBe("new");
  });

  it("ignores a malformed expires_in instead of producing an Invalid Date", async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            access_token: "new",
            token_type: "Bearer",
            expires_in: "not-a-number",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await refreshAccessToken(baseToken);

    expect(result.success).toBe(true);
    expect(result.expiresIn).toBeUndefined();
  });

  it("keeps expires_in: 0 as already-expired, not never-expiring", async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            access_token: "new",
            token_type: "Bearer",
            expires_in: 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await refreshAccessToken(baseToken);

    expect(result.success).toBe(true);
    expect(result.expiresIn).toBe(0);
  });

  it("ignores a negative expires_in", async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            access_token: "new",
            token_type: "Bearer",
            expires_in: -1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await refreshAccessToken(baseToken);

    expect(result.success).toBe(true);
    expect(result.expiresIn).toBeUndefined();
  });

  it("ignores an absurdly large expires_in instead of producing an Invalid Date downstream", async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            access_token: "new",
            token_type: "Bearer",
            expires_in: 1e20,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await refreshAccessToken(baseToken);

    expect(result.success).toBe(true);
    expect(result.expiresIn).toBeUndefined();
  });

  it("treats a 200 with no access_token as a transient failure, not success", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ token_type: "Bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await refreshAccessToken(baseToken);

    expect(result.success).toBe(false);
    expect(result.permanent).toBe(false);
    expect(result.accessToken).toBeUndefined();
  });

  it("treats a non-string access_token as a transient failure, not success", async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ access_token: 12345 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const result = await refreshAccessToken(baseToken);

    expect(result.success).toBe(false);
    expect(result.permanent).toBe(false);
    expect(result.accessToken).toBeUndefined();
  });

  it("falls back to the prior refresh token when the response's refresh_token isn't a string", async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({ access_token: "new", refresh_token: 987 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await refreshAccessToken(baseToken);

    expect(result.success).toBe(true);
    expect(result.refreshToken).toBe("rt");
  });
});
