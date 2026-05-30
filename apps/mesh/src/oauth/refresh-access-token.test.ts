import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { refreshAccessToken } from "./refresh-access-token";
import type { DownstreamToken } from "../storage/types";

const baseToken: DownstreamToken = {
  id: "dtok_test",
  connectionId: "conn_test",
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
});
