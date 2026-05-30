import { describe, it, expect } from "bun:test";
import { createOAuthHandlers, OAuthInvalidGrantError } from "./oauth.ts";
import type { OAuthConfig } from "./tools.ts";

const baseConfig = (
  refreshToken?: OAuthConfig["refreshToken"],
): OAuthConfig => ({
  mode: "PKCE",
  authorizationServer: "https://upstream.example.com",
  authorizationUrl: () => "https://upstream.example.com/authorize",
  exchangeCode: async () => ({
    access_token: "at",
    token_type: "Bearer",
  }),
  refreshToken,
});

const buildTokenRequest = (body: Record<string, string>) =>
  new Request("https://mcp.example.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

describe("OAuth /token refresh handler", () => {
  it("returns 400 invalid_grant when refreshToken throws OAuthInvalidGrantError", async () => {
    const handlers = createOAuthHandlers(
      baseConfig(async () => {
        throw new OAuthInvalidGrantError(
          "invalid_grant",
          "refresh token revoked",
        );
      }),
    );

    const response = await handlers.handleToken(
      buildTokenRequest({
        grant_type: "refresh_token",
        refresh_token: "rt",
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      error_description?: string;
    };
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toBe("refresh token revoked");
  });

  it("returns 500 server_error when refreshToken throws a generic error", async () => {
    const handlers = createOAuthHandlers(
      baseConfig(async () => {
        throw new Error("upstream is down");
      }),
    );

    const response = await handlers.handleToken(
      buildTokenRequest({
        grant_type: "refresh_token",
        refresh_token: "rt",
      }),
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("server_error");
  });

  it("forwards the new token on success", async () => {
    const handlers = createOAuthHandlers(
      baseConfig(async () => ({
        access_token: "fresh",
        token_type: "Bearer",
        refresh_token: "rt2",
        expires_in: 3600,
      })),
    );

    const response = await handlers.handleToken(
      buildTokenRequest({
        grant_type: "refresh_token",
        refresh_token: "rt",
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
    };
    expect(body.access_token).toBe("fresh");
    expect(body.refresh_token).toBe("rt2");
  });
});
