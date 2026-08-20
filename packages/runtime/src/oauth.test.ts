import { describe, it, expect } from "bun:test";
import { createOAuthHandlers, OAuthInvalidGrantError } from "./oauth.ts";
import type { OAuthClient, OAuthConfig } from "./tools.ts";

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

const REGISTERED = "https://client.example.com/callback";

const withPersistence = (
  clients: OAuthClient[],
  extra: Partial<OAuthConfig> = {},
): OAuthConfig => ({
  ...baseConfig(),
  persistence: {
    getClient: async (clientId) =>
      clients.find((client) => client.client_id === clientId) ?? null,
    saveClient: async () => {},
  },
  ...extra,
});

const registeredClient = (redirectUris: string[]): OAuthClient => ({
  client_id: "client-1",
  redirect_uris: redirectUris,
});

const authorizeRequest = (params: Record<string, string>) =>
  new Request(
    `https://mcp.example.com/authorize?${new URLSearchParams({
      response_type: "code",
      ...params,
    }).toString()}`,
  );

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: string }).error;

describe("OAuth /authorize redirect_uri validation", () => {
  it("rejects a redirect_uri with a non-https, non-local scheme", async () => {
    const handlers = createOAuthHandlers(
      withPersistence([registeredClient([REGISTERED])]),
    );

    const response = await handlers.handleAuthorize(
      authorizeRequest({
        client_id: "client-1",
        redirect_uri: "http://attacker.example.com/callback",
      }),
    );

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("invalid_request");
  });

  it("rejects an https redirect_uri the client never registered", async () => {
    const handlers = createOAuthHandlers(
      withPersistence([registeredClient([REGISTERED])]),
    );

    const response = await handlers.handleAuthorize(
      authorizeRequest({
        client_id: "client-1",
        redirect_uri: "https://studio.evil.com/oauth/callback",
      }),
    );

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("invalid_request");
    expect(response.headers.get("location")).toBeNull();
  });

  it("rejects a request without client_id", async () => {
    const handlers = createOAuthHandlers(
      withPersistence([registeredClient([REGISTERED])]),
    );

    const response = await handlers.handleAuthorize(
      authorizeRequest({ redirect_uri: REGISTERED }),
    );

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("invalid_request");
  });

  it("rejects an unknown client_id", async () => {
    const handlers = createOAuthHandlers(
      withPersistence([registeredClient([REGISTERED])]),
    );

    const response = await handlers.handleAuthorize(
      authorizeRequest({ client_id: "nope", redirect_uri: REGISTERED }),
    );

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("invalid_client");
  });

  it("rejects a registered URI that differs only by a trailing slash", async () => {
    const handlers = createOAuthHandlers(
      withPersistence([registeredClient([REGISTERED])]),
    );

    const response = await handlers.handleAuthorize(
      authorizeRequest({
        client_id: "client-1",
        redirect_uri: `${REGISTERED}/`,
      }),
    );

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("invalid_request");
  });

  it("rejects a registered URI that differs only by an extra query param", async () => {
    const handlers = createOAuthHandlers(
      withPersistence([registeredClient([REGISTERED])]),
    );

    const response = await handlers.handleAuthorize(
      authorizeRequest({
        client_id: "client-1",
        redirect_uri: `${REGISTERED}?next=https://evil.example.com`,
      }),
    );

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("invalid_request");
  });

  it("accepts an exactly matching registered redirect_uri", async () => {
    const handlers = createOAuthHandlers(
      withPersistence([registeredClient([REGISTERED])]),
    );

    const response = await handlers.handleAuthorize(
      authorizeRequest({ client_id: "client-1", redirect_uri: REGISTERED }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://upstream.example.com/authorize",
    );
  });

  it("allows a native client's loopback redirect on a different port", async () => {
    const handlers = createOAuthHandlers(
      withPersistence([registeredClient(["http://127.0.0.1:8080/callback"])]),
    );

    const response = await handlers.handleAuthorize(
      authorizeRequest({
        client_id: "client-1",
        redirect_uri: "http://127.0.0.1:51234/callback",
      }),
    );

    expect(response.status).toBe(302);
  });

  it("does not extend the loopback port relaxation to the path", async () => {
    const handlers = createOAuthHandlers(
      withPersistence([registeredClient(["http://127.0.0.1:8080/callback"])]),
    );

    const response = await handlers.handleAuthorize(
      authorizeRequest({
        client_id: "client-1",
        redirect_uri: "http://127.0.0.1:8080/other",
      }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects every redirect_uri when the server has no client store and no host allowlist", async () => {
    const handlers = createOAuthHandlers(baseConfig());

    const response = await handlers.handleAuthorize(
      authorizeRequest({
        client_id: "client-1",
        redirect_uri: "https://client.example.com/callback",
      }),
    );

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("invalid_client");
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("OAuth /authorize allowedRedirectHosts", () => {
  const allowlisted = (redirectUri: string) =>
    createOAuthHandlers({
      ...baseConfig(),
      allowedRedirectHosts: ["decocms.com"],
    }).handleAuthorize(
      authorizeRequest({ client_id: "client-1", redirect_uri: redirectUri }),
    );

  it("accepts a subdomain of an allowed host", async () => {
    const response = await allowlisted(
      "https://github-mcp.decocms.com/oauth/callback",
    );
    expect(response.status).toBe(302);
  });

  it("accepts the allowed host itself", async () => {
    const response = await allowlisted("https://decocms.com/oauth/callback");
    expect(response.status).toBe(302);
  });

  it("rejects a host that only ends with the allowed string", async () => {
    const response = await allowlisted("https://evildecocms.com/callback");
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("invalid_request");
  });

  it("rejects a host that only starts with the allowed string", async () => {
    const response = await allowlisted("https://decocms.com.attacker.io/cb");
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("invalid_request");
  });

  it("rejects http on an allowed host", async () => {
    const response = await allowlisted("http://decocms.com/callback");
    expect(response.status).toBe(400);
  });

  it("still requires the client's registered URI when persistence is configured", async () => {
    const handlers = createOAuthHandlers(
      withPersistence(
        [registeredClient(["https://app.decocms.com/callback"])],
        {
          allowedRedirectHosts: ["decocms.com"],
        },
      ),
    );

    const response = await handlers.handleAuthorize(
      authorizeRequest({
        client_id: "client-1",
        redirect_uri: "https://other.decocms.com/callback",
      }),
    );

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("invalid_request");
  });
});

describe("OAuth /oauth/callback redirect_uri validation", () => {
  const forgedState = (redirectUri: string) =>
    btoa(JSON.stringify({ redirectUri, clientId: "client-1" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  const callback = (config: OAuthConfig, state: string) =>
    createOAuthHandlers(config).handleOAuthCallback(
      new Request(
        `https://mcp.example.com/oauth/callback?code=upstream-code&state=${state}`,
      ),
    );

  it("does not redirect to a redirect_uri smuggled in through a forged state", async () => {
    const response = await callback(
      withPersistence([registeredClient([REGISTERED])]),
      forgedState("https://studio.evil.com/oauth/callback"),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not redirect to a forged state on the upstream error path", async () => {
    const handlers = createOAuthHandlers(
      withPersistence([registeredClient([REGISTERED])]),
    );

    const response = await handlers.handleOAuthCallback(
      new Request(
        `https://mcp.example.com/oauth/callback?error=access_denied&state=${forgedState(
          "https://studio.evil.com/oauth/callback",
        )}`,
      ),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("redirects to the client's registered redirect_uri with our code", async () => {
    const response = await callback(
      withPersistence([registeredClient([REGISTERED])]),
      forgedState(REGISTERED),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(REGISTERED);
    expect(location.searchParams.get("code")).toBeTruthy();
  });
});

describe("OAuth stateSecret sealing", () => {
  const sealingConfig = () =>
    withPersistence([registeredClient([REGISTERED])], {
      stateSecret: "a-high-entropy-secret",
      exchangeCode: async () => ({
        access_token: "upstream-token",
        token_type: "Bearer",
      }),
    });

  it("does not leak the redirect_uri in the state it sends upstream", async () => {
    let upstreamCallback = "";
    const handlers = createOAuthHandlers({
      ...sealingConfig(),
      authorizationUrl: (callbackUrl) => {
        upstreamCallback = callbackUrl;
        return "https://upstream.example.com/authorize";
      },
    });

    await handlers.handleAuthorize(
      authorizeRequest({ client_id: "client-1", redirect_uri: REGISTERED }),
    );

    const state = new URL(upstreamCallback).searchParams.get("state") ?? "";
    expect(state).toStartWith("v1.");
    expect(state).not.toContain(btoa("client.example.com").replace(/=+$/, ""));
  });

  it("rejects a plaintext state once a stateSecret is configured", async () => {
    const handlers = createOAuthHandlers(sealingConfig());

    const response = await handlers.handleOAuthCallback(
      new Request(
        `https://mcp.example.com/oauth/callback?code=c&state=${btoa(
          JSON.stringify({ redirectUri: REGISTERED, clientId: "client-1" }),
        )
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "")}`,
      ),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("round-trips a sealed code without exposing the upstream token", async () => {
    const handlers = createOAuthHandlers(sealingConfig());

    let upstreamCallback = "";
    const authorizeHandlers = createOAuthHandlers({
      ...sealingConfig(),
      stateSecret: "a-high-entropy-secret",
      authorizationUrl: (callbackUrl) => {
        upstreamCallback = callbackUrl;
        return "https://upstream.example.com/authorize";
      },
    });
    await authorizeHandlers.handleAuthorize(
      authorizeRequest({ client_id: "client-1", redirect_uri: REGISTERED }),
    );
    const state = new URL(upstreamCallback).searchParams.get("state") ?? "";

    const callbackResponse = await handlers.handleOAuthCallback(
      new Request(
        `https://mcp.example.com/oauth/callback?code=upstream-code&state=${encodeURIComponent(
          state,
        )}`,
      ),
    );
    const ourCode =
      new URL(callbackResponse.headers.get("location") ?? "").searchParams.get(
        "code",
      ) ?? "";

    expect(ourCode).toStartWith("v1.");
    expect(ourCode).not.toContain("upstream-token");

    const tokenResponse = await handlers.handleToken(
      buildTokenRequest({ grant_type: "authorization_code", code: ourCode }),
    );
    expect(tokenResponse.status).toBe(200);
    expect(
      ((await tokenResponse.json()) as { access_token: string }).access_token,
    ).toBe("upstream-token");
  });

  it("rejects a tampered sealed code", async () => {
    const handlers = createOAuthHandlers(sealingConfig());

    const response = await handlers.handleToken(
      buildTokenRequest({
        grant_type: "authorization_code",
        code: "v1.QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo",
      }),
    );

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("invalid_grant");
  });
});

describe("OAuth dynamic client registration redirect_uri validation", () => {
  const registerRequest = (redirectUris: string[]) =>
    new Request("https://mcp.example.com/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: redirectUris }),
    });

  it("accepts an IPv6 loopback redirect_uri", async () => {
    const handlers = createOAuthHandlers(baseConfig());

    const response = await handlers.handleClientRegistration(
      registerRequest(["http://[::1]:51234/callback"]),
    );

    expect(response.status).toBe(201);
  });

  it("rejects a non-https, non-loopback redirect_uri", async () => {
    const handlers = createOAuthHandlers(baseConfig());

    const response = await handlers.handleClientRegistration(
      registerRequest(["http://example.com/callback"]),
    );

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("invalid_redirect_uri");
  });
});
