/**
 * Pure unit tests for the OAuth proxy transforms. No mocks: every function
 * here is data-in / data-out, so we just assert outputs. The fetch
 * orchestration and connection lookup that wire these together live in
 * oauth-proxy.ts and are covered by e2e against a real origin server.
 */

import { describe, expect, test } from "bun:test";
import {
  authorizationServerMetadataUrls,
  buildPathPrefix,
  isAuthError,
  isAuthServerMetadata,
  looksLikeOAuthWwwAuthenticate,
  protectedResourceMetadataUrls,
  resourceMetadataChallenge,
  rewriteAuthServerMetadata,
  rewriteProtectedResourceMetadata,
  scopesFromOrigin,
  syntheticProtectedResourceMetadata,
} from "./oauth-proxy-metadata";

describe("buildPathPrefix", () => {
  test("org slug → /api/<slug>", () => {
    expect(buildPathPrefix("acme")).toBe("/api/acme");
  });
  test("no slug → empty (legacy root shape)", () => {
    expect(buildPathPrefix(undefined)).toBe("");
  });
});

describe("protectedResourceMetadataUrls (RFC 9728 probe order)", () => {
  test("emits resource-relative, well-known-prefix, then root", () => {
    expect(
      protectedResourceMetadataUrls("https://origin.example.com/mcp"),
    ).toEqual([
      "https://origin.example.com/mcp/.well-known/oauth-protected-resource",
      "https://origin.example.com/.well-known/oauth-protected-resource/mcp",
      "https://origin.example.com/.well-known/oauth-protected-resource",
    ]);
  });

  test("strips a trailing slash on the resource path", () => {
    const [format1] = protectedResourceMetadataUrls(
      "https://origin.example.com/mcp/",
    );
    expect(format1).toBe(
      "https://origin.example.com/mcp/.well-known/oauth-protected-resource",
    );
  });

  test("handles a multi-segment resource path (Smithery-style)", () => {
    expect(
      protectedResourceMetadataUrls(
        "https://server.smithery.ai/@exa-labs/exa-code-mcp/mcp",
      ),
    ).toEqual([
      "https://server.smithery.ai/@exa-labs/exa-code-mcp/mcp/.well-known/oauth-protected-resource",
      "https://server.smithery.ai/.well-known/oauth-protected-resource/@exa-labs/exa-code-mcp/mcp",
      "https://server.smithery.ai/.well-known/oauth-protected-resource",
    ]);
  });

  test("root-path connection collapses format 1 and 2 onto the root URL", () => {
    expect(
      protectedResourceMetadataUrls("https://origin.example.com/"),
    ).toEqual([
      "https://origin.example.com/.well-known/oauth-protected-resource",
      "https://origin.example.com/.well-known/oauth-protected-resource",
      "https://origin.example.com/.well-known/oauth-protected-resource",
    ]);
  });
});

describe("authorizationServerMetadataUrls (RFC 8414 / OIDC probe order)", () => {
  test("root issuer → OAuth 2.0 then OIDC, no path suffix", () => {
    expect(
      authorizationServerMetadataUrls("https://auth.example.com/"),
    ).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
    for (const url of authorizationServerMetadataUrls(
      "https://auth.example.com/",
    )) {
      expect(url).not.toEndWith("/");
    }
  });

  test("issuer with a path → insertion (OAuth + OIDC) then append (OIDC)", () => {
    expect(
      authorizationServerMetadataUrls("https://auth.example.com/tenant1"),
    ).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
      "https://auth.example.com/.well-known/openid-configuration/tenant1",
      "https://auth.example.com/tenant1/.well-known/openid-configuration",
    ]);
  });

  test("deep issuer path is preserved verbatim", () => {
    const [oauth] = authorizationServerMetadataUrls(
      "https://auth.example.com/v1/oauth/server",
    );
    expect(oauth).toBe(
      "https://auth.example.com/.well-known/oauth-authorization-server/v1/oauth/server",
    );
  });
});

describe("isAuthServerMetadata", () => {
  test("true for AS metadata (issuer + endpoints, no resource)", () => {
    expect(
      isAuthServerMetadata({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
      }),
    ).toBe(true);
  });

  test("false when a resource field is present (real PR metadata)", () => {
    expect(
      isAuthServerMetadata({
        issuer: "https://auth.example.com",
        resource: "https://origin.example.com/mcp",
        authorization_endpoint: "https://auth.example.com/authorize",
      }),
    ).toBe(false);
  });

  test("false when there are no endpoint fields", () => {
    expect(isAuthServerMetadata({ issuer: "https://auth.example.com" })).toBe(
      false,
    );
  });
});

describe("looksLikeOAuthWwwAuthenticate", () => {
  test("true for RFC 9728 resource_metadata", () => {
    expect(
      looksLikeOAuthWwwAuthenticate(
        'Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"',
      ),
    ).toBe(true);
  });
  test("true for standard OAuth hints (invalid_token / oauth)", () => {
    expect(looksLikeOAuthWwwAuthenticate('Bearer error="invalid_token"')).toBe(
      true,
    );
    expect(looksLikeOAuthWwwAuthenticate("OAuth realm=mcp")).toBe(true);
  });
  test("false for a bare Bearer/API-key challenge", () => {
    expect(looksLikeOAuthWwwAuthenticate('Bearer realm="api"')).toBe(false);
  });
});

describe("isAuthError", () => {
  test("true on status/code 401", () => {
    expect(isAuthError({ status: 401 })).toBe(true);
    expect(isAuthError({ code: 401 })).toBe(true);
  });
  test("true on auth-flavored messages", () => {
    expect(isAuthError({ message: "HTTP 401 Unauthorized" })).toBe(true);
    expect(isAuthError({ message: "invalid_token" })).toBe(true);
    expect(isAuthError({ message: "API key required" })).toBe(true);
    expect(isAuthError({ message: "api-key required" })).toBe(true);
  });
  test("false for unrelated errors", () => {
    expect(isAuthError({ status: 500, message: "boom" })).toBe(false);
    expect(isAuthError({})).toBe(false);
  });
});

const PROXY = {
  proxyResourceUrl: "http://localhost:3000/mcp/conn_123",
  proxyAuthServer: "http://localhost:3000/oauth-proxy/conn_123",
};

describe("rewriteProtectedResourceMetadata", () => {
  test("rewrites resource + authorization_servers, preserves other fields", () => {
    expect(
      rewriteProtectedResourceMetadata(
        {
          resource: "https://origin.example.com/mcp",
          authorization_servers: ["https://origin.example.com"],
          scopes_supported: ["read", "write"],
        },
        PROXY,
      ),
    ).toEqual({
      resource: "http://localhost:3000/mcp/conn_123",
      authorization_servers: ["http://localhost:3000/oauth-proxy/conn_123"],
      scopes_supported: ["read", "write"],
    });
  });
});

describe("syntheticProtectedResourceMetadata", () => {
  test("defaults scopes to ['*']", () => {
    expect(syntheticProtectedResourceMetadata(PROXY)).toEqual({
      resource: "http://localhost:3000/mcp/conn_123",
      authorization_servers: ["http://localhost:3000/oauth-proxy/conn_123"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["*"],
    });
  });

  test("honors provided scopes and never spreads origin fields", () => {
    const out = syntheticProtectedResourceMetadata({
      ...PROXY,
      scopesSupported: ["a", "b"],
    });
    expect(out.scopes_supported).toEqual(["a", "b"]);
    expect(out).not.toHaveProperty("issuer");
  });
});

describe("scopesFromOrigin", () => {
  test("uses a non-empty origin scopes array", () => {
    expect(scopesFromOrigin({ scopes_supported: ["x"] })).toEqual(["x"]);
  });
  test("falls back to ['*'] for empty/missing/non-array", () => {
    expect(scopesFromOrigin({ scopes_supported: [] })).toEqual(["*"]);
    expect(scopesFromOrigin({})).toEqual(["*"]);
    expect(scopesFromOrigin({ scopes_supported: "nope" })).toEqual(["*"]);
  });
});

describe("rewriteAuthServerMetadata", () => {
  const base = "http://localhost:3000/api/acme/oauth-proxy/conn_123";

  test("rewrites present endpoints to our proxy, preserves other fields", () => {
    expect(
      rewriteAuthServerMetadata(
        {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: "https://auth.example.com/register",
        },
        base,
      ),
    ).toEqual({
      issuer: "https://auth.example.com",
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
    });
  });

  test("leaves absent endpoints undefined (does not invent them)", () => {
    const out = rewriteAuthServerMetadata(
      {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
      },
      base,
    );
    expect(out.registration_endpoint).toBeUndefined();
    expect(out.authorization_endpoint).toBe(`${base}/authorize`);
  });
});

describe("resourceMetadataChallenge", () => {
  test("legacy shape (no prefix)", () => {
    expect(
      resourceMetadataChallenge({
        origin: "http://localhost:3000",
        prefix: "",
        connectionId: "conn_123",
      }),
    ).toBe(
      'Bearer realm="mcp",resource_metadata="http://localhost:3000/mcp/conn_123/.well-known/oauth-protected-resource"',
    );
  });

  test("org-scoped shape (with /api/<slug> prefix)", () => {
    expect(
      resourceMetadataChallenge({
        origin: "http://localhost:3000",
        prefix: "/api/acme",
        connectionId: "conn_123",
      }),
    ).toBe(
      'Bearer realm="mcp",resource_metadata="http://localhost:3000/api/acme/mcp/conn_123/.well-known/oauth-protected-resource"',
    );
  });
});
