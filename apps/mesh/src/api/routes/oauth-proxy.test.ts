import {
  describe,
  expect,
  test,
  mock,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import { Hono } from "hono";
import oauthProxyRoutes from "./oauth-proxy";
import { ContextFactory } from "../../core/context-factory";
import {
  isDecoHostedMcp,
  DECO_STORE_URL,
  DECO_CMS_API_HOST,
} from "@/core/deco-constants";

describe("OAuth Proxy Routes", () => {
  let app: Hono;
  let originalFetch: typeof fetch;
  let contextFactorySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    app = new Hono();
    app.route("/", oauthProxyRoutes);
    originalFetch = global.fetch;

    // Spy on ContextFactory.create - this doesn't affect other test files
    contextFactorySpy = spyOn(ContextFactory, "create").mockResolvedValue({
      storage: {
        connections: {
          findById: mock(() => Promise.resolve(null)),
        },
      },
    } as never);
  });

  afterEach(() => {
    // Restore original fetch and mocks
    global.fetch = originalFetch;
    contextFactorySpy.mockRestore();
    mock.restore();
  });

  describe("Protected Resource Metadata Proxy", () => {
    const mockConnectionStorage = (
      connection: {
        connection_url?: string;
      } | null,
    ) => {
      contextFactorySpy.mockResolvedValue({
        storage: {
          connections: {
            findById: mock(() => Promise.resolve(connection)),
          },
        },
      } as never);
    };

    test("returns 404 when connection not found", async () => {
      mockConnectionStorage(null);

      const res = await app.request(
        "/.well-known/oauth-protected-resource/mcp/conn_notfound",
      );

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Connection not found");
    });

    test("proxies and rewrites protected resource metadata", async () => {
      mockConnectionStorage({
        connection_url: "https://origin.example.com/mcp",
      });

      // Mock fetch to origin server
      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              resource: "https://origin.example.com/mcp",
              authorization_servers: ["https://origin.example.com"],
              scopes_supported: ["*"],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ) as unknown as typeof fetch;

      const res = await app.request(
        "http://localhost:3000/.well-known/oauth-protected-resource/mcp/conn_123",
      );

      expect(res.status).toBe(200);
      const body = await res.json();

      // Should rewrite resource URL to our proxy
      expect(body.resource).toBe("http://localhost:3000/mcp/conn_123");
      // Should rewrite authorization_servers to our proxy
      expect(body.authorization_servers).toEqual([
        "http://localhost:3000/oauth-proxy/conn_123",
      ]);
      // Should preserve other fields
      expect(body.scopes_supported).toEqual(["*"]);
    });

    test("works with alternative route pattern /mcp/:connectionId/.well-known/...", async () => {
      mockConnectionStorage({
        connection_url: "https://origin.example.com/mcp",
      });

      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              resource: "https://origin.example.com/mcp",
              authorization_servers: ["https://origin.example.com"],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ) as unknown as typeof fetch;

      const res = await app.request(
        "http://localhost:3000/mcp/conn_123/.well-known/oauth-protected-resource",
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.resource).toBe("http://localhost:3000/mcp/conn_123");
    });

    test("falls back to format 2 (Smithery-style) when format 1 returns 404", async () => {
      mockConnectionStorage({
        connection_url: "https://server.smithery.ai/@exa-labs/exa-code-mcp/mcp",
      });

      let fetchCallCount = 0;
      global.fetch = mock((url: string) => {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          // Format 1: {resource}/.well-known/... - returns 404
          expect(url).toBe(
            "https://server.smithery.ai/@exa-labs/exa-code-mcp/mcp/.well-known/oauth-protected-resource",
          );
          return Promise.resolve(
            new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
            }),
          );
        }
        // Format 2: /.well-known/...{resource-path} - Smithery style
        expect(url).toBe(
          "https://server.smithery.ai/.well-known/oauth-protected-resource/@exa-labs/exa-code-mcp/mcp",
        );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              resource: "https://server.smithery.ai/@exa-labs/exa-code-mcp/mcp",
              authorization_servers: [
                "https://auth.smithery.ai/@exa-labs/exa-code-mcp",
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }) as unknown as typeof fetch;

      const res = await app.request(
        "http://localhost:3000/.well-known/oauth-protected-resource/mcp/conn_123",
      );

      expect(res.status).toBe(200);
      expect(fetchCallCount).toBe(2);

      const body = await res.json();
      expect(body.resource).toBe("http://localhost:3000/mcp/conn_123");
      expect(body.authorization_servers).toEqual([
        "http://localhost:3000/oauth-proxy/conn_123",
      ]);
    });

    test("normalizes trailing slash in resource path (RFC 9728)", async () => {
      mockConnectionStorage({
        connection_url: "https://origin.example.com/mcp/", // Trailing slash
      });

      global.fetch = mock((url: string) => {
        // Should strip trailing slash before .well-known
        expect(url).toBe(
          "https://origin.example.com/mcp/.well-known/oauth-protected-resource",
        );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              resource: "https://origin.example.com/mcp",
              authorization_servers: ["https://auth.example.com"],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }) as unknown as typeof fetch;

      const res = await app.request(
        "http://localhost:3000/.well-known/oauth-protected-resource/mcp/conn_123",
      );

      expect(res.status).toBe(200);
    });

    test("handles root path resource correctly", async () => {
      mockConnectionStorage({
        connection_url: "https://origin.example.com/", // Root path
      });

      global.fetch = mock((url: string) => {
        // Should produce /.well-known/... not //.well-known/...
        expect(url).toBe(
          "https://origin.example.com/.well-known/oauth-protected-resource",
        );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              resource: "https://origin.example.com",
              authorization_servers: ["https://auth.example.com"],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }) as unknown as typeof fetch;

      const res = await app.request(
        "http://localhost:3000/.well-known/oauth-protected-resource/mcp/conn_123",
      );

      expect(res.status).toBe(200);
    });

    test("returns 502 when origin fetch fails", async () => {
      mockConnectionStorage({
        connection_url: "https://origin.example.com/mcp",
      });

      global.fetch = mock(() =>
        Promise.reject(new Error("Network error")),
      ) as unknown as typeof fetch;

      const res = await app.request(
        "/.well-known/oauth-protected-resource/mcp/conn_123",
      );

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe("Failed to proxy OAuth metadata");
    });

    test("passes through error responses from origin", async () => {
      mockConnectionStorage({
        connection_url: "https://origin.example.com/mcp",
      });

      global.fetch = mock(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "Not authorized" }), {
            status: 401,
            statusText: "Unauthorized",
          }),
        ),
      ) as unknown as typeof fetch;

      const res = await app.request(
        "/.well-known/oauth-protected-resource/mcp/conn_123",
      );

      expect(res.status).toBe(401);
    });

    test("generates synthetic metadata when origin has no metadata but supports OAuth via WWW-Authenticate", async () => {
      mockConnectionStorage({
        connection_url: "https://mcp.example.com",
      });

      global.fetch = mock((url: string, options?: RequestInit) => {
        // First 3 calls: Protected Resource Metadata discovery (returns 404)
        if (
          (url as string).includes("oauth-protected-resource") &&
          options?.method === "GET"
        ) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
              statusText: "Not Found",
            }),
          );
        }

        // 4th call: checkOriginSupportsOAuth - returns 401 with WWW-Authenticate
        if (options?.method === "POST") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: "invalid_token",
                error_description: "Missing or invalid access token",
              }),
              {
                status: 401,
                headers: {
                  "WWW-Authenticate":
                    'Bearer realm="OAuth", error="invalid_token"',
                  "Content-Type": "application/json",
                },
              },
            ),
          );
        }

        return Promise.resolve(
          new Response(JSON.stringify({ error: "Unexpected request" }), {
            status: 500,
          }),
        );
      }) as unknown as typeof fetch;

      const res = await app.request(
        "http://localhost:3000/.well-known/oauth-protected-resource/mcp/conn_123",
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        resource: string;
        authorization_servers: string[];
        bearer_methods_supported: string[];
        scopes_supported: string[];
      };
      expect(body.resource).toBe("http://localhost:3000/mcp/conn_123");
      expect(body.authorization_servers).toEqual([
        "http://localhost:3000/oauth-proxy/conn_123",
      ]);
      expect(body.bearer_methods_supported).toEqual(["header"]);
      expect(body.scopes_supported).toEqual(["*"]);
    });

    test("returns 404 when origin has no metadata and does not support OAuth", async () => {
      mockConnectionStorage({
        connection_url: "https://mcp.example.com",
      });

      global.fetch = mock((url: string, options?: RequestInit) => {
        // Protected Resource Metadata discovery (returns 404)
        if (
          (url as string).includes("oauth-protected-resource") &&
          options?.method === "GET"
        ) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
              statusText: "Not Found",
            }),
          );
        }

        // checkOriginSupportsOAuth - returns 401 WITHOUT WWW-Authenticate (no OAuth support)
        if (options?.method === "POST") {
          return Promise.resolve(
            new Response(JSON.stringify({ error: "Unauthorized" }), {
              status: 401,
              headers: {
                "Content-Type": "application/json",
              },
            }),
          );
        }

        return Promise.resolve(
          new Response(JSON.stringify({ error: "Unexpected request" }), {
            status: 500,
          }),
        );
      }) as unknown as typeof fetch;

      const res = await app.request(
        "http://localhost:3000/.well-known/oauth-protected-resource/mcp/conn_123",
      );

      // Should pass through the 404 since origin doesn't support OAuth
      expect(res.status).toBe(404);
    });

    test("generates clean synthetic metadata when origin returns auth server metadata at protected resource endpoint (ClickHouse-style)", async () => {
      // Some servers like ClickHouse incorrectly return Authorization Server Metadata (RFC 8414)
      // at the protected resource endpoint instead of Protected Resource Metadata (RFC 9728).
      // We need to detect this and generate clean synthetic metadata.
      mockConnectionStorage({
        connection_url: "https://mcp.clickhouse.cloud/mcp",
      });

      // Mock ClickHouse-style response: auth server metadata at protected resource endpoint
      global.fetch = mock(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              // This is auth server metadata (RFC 8414), NOT protected resource metadata!
              issuer: "https://mcp.clickhouse.cloud",
              authorization_endpoint: "https://mcp.clickhouse.cloud/authorize",
              token_endpoint: "https://mcp.clickhouse.cloud/token",
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              scopes_supported: ["openid", "profile", "email"],
              registration_endpoint: "https://mcp.clickhouse.cloud/register",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ) as unknown as typeof fetch;

      const res = await app.request(
        "http://localhost:3000/.well-known/oauth-protected-resource/mcp/conn_123",
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        resource: string;
        authorization_servers: string[];
        bearer_methods_supported: string[];
        scopes_supported: string[];
        issuer?: string;
        authorization_endpoint?: string;
      };

      // Should have clean RFC 9728 Protected Resource Metadata
      expect(body.resource).toBe("http://localhost:3000/mcp/conn_123");
      expect(body.authorization_servers).toEqual([
        "http://localhost:3000/oauth-proxy/conn_123",
      ]);
      expect(body.bearer_methods_supported).toEqual(["header"]);
      // Should preserve scopes from origin
      expect(body.scopes_supported).toEqual(["openid", "profile", "email"]);

      // Should NOT have auth server metadata fields that would confuse MCP SDK
      expect(body.issuer).toBeUndefined();
      expect(body.authorization_endpoint).toBeUndefined();
    });
  });

  describe("Authorization Server Metadata Proxy", () => {
    // Default org slug used by mocked connections. The handler emits OAuth
    // endpoint URLs under `/api/${slug}/oauth-proxy/...` so it can route DCR
    // through `resolveOrgFromPath`. Tests that assert the rewritten URLs use
    // this slug.
    const TEST_ORG_SLUG = "org-test";

    const mockOrgDb = (slug: string | null) => ({
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: () =>
              slug ? Promise.resolve({ slug }) : Promise.resolve(undefined),
          }),
        }),
      }),
    });

    const mockConnectionWithAuthServer = (
      connection:
        | ({ connection_url?: string; organization_id?: string } | null)
        | undefined,
      protectedResourceResponse?: Response,
      orgSlug: string | null = TEST_ORG_SLUG,
    ) => {
      (ContextFactory.create as ReturnType<typeof mock>).mockImplementation(
        () =>
          Promise.resolve({
            storage: {
              connections: {
                findById: mock(() =>
                  Promise.resolve(
                    connection
                      ? { organization_id: "org_test", ...connection }
                      : connection,
                  ),
                ),
              },
            },
            db: mockOrgDb(orgSlug),
          }),
      );

      if (protectedResourceResponse) {
        global.fetch = mock((url: string) => {
          if (url.includes("oauth-protected-resource")) {
            return Promise.resolve(protectedResourceResponse);
          }
          // Default auth server metadata response
          return Promise.resolve(
            new Response(
              JSON.stringify({
                issuer: "https://origin.example.com",
                authorization_endpoint: "https://origin.example.com/authorize",
                token_endpoint: "https://origin.example.com/token",
                registration_endpoint: "https://origin.example.com/register",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }) as unknown as typeof fetch;
      }
    };

    test("returns 404 when connection not found", async () => {
      mockConnectionWithAuthServer(null);

      const res = await app.request(
        "/.well-known/oauth-authorization-server/oauth-proxy/conn_notfound",
      );

      expect(res.status).toBe(404);
    });

    test("falls back to origin root when protected resource metadata has empty auth servers", async () => {
      // When Protected Resource Metadata has empty authorization_servers,
      // we should fall back to the origin's root and try to fetch auth server metadata from there
      (ContextFactory.create as ReturnType<typeof mock>).mockImplementation(
        () =>
          Promise.resolve({
            storage: {
              connections: {
                findById: mock(() =>
                  Promise.resolve({
                    connection_url: "https://origin.example.com/mcp",
                    organization_id: "org_test",
                  }),
                ),
              },
            },
            db: mockOrgDb(TEST_ORG_SLUG),
          }),
      );

      global.fetch = mock((url: string) => {
        if ((url as string).includes("oauth-protected-resource")) {
          // Return metadata with empty auth servers
          return Promise.resolve(
            new Response(
              JSON.stringify({
                resource: "https://origin.example.com/mcp",
                authorization_servers: [], // Empty - should trigger fallback
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        // Auth server metadata at origin root
        if ((url as string).includes("oauth-authorization-server")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                issuer: "https://origin.example.com",
                authorization_endpoint: "https://origin.example.com/authorize",
                token_endpoint: "https://origin.example.com/token",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ error: "Unexpected" }), {
            status: 500,
          }),
        );
      }) as unknown as typeof fetch;

      const res = await app.request(
        "http://localhost:3000/.well-known/oauth-authorization-server/oauth-proxy/conn_123",
      );

      // Should succeed by falling back to origin root
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        authorization_endpoint: string;
        token_endpoint: string;
      };
      // URLs are rewritten through our proxy under the org-scoped mount so DCR
      // benefits from `resolveOrgFromPath` membership enforcement.
      expect(body.authorization_endpoint).toBe(
        `http://localhost:3000/api/${TEST_ORG_SLUG}/oauth-proxy/conn_123/authorize`,
      );
      expect(body.token_endpoint).toBe(
        `http://localhost:3000/api/${TEST_ORG_SLUG}/oauth-proxy/conn_123/token`,
      );
    });

    test("proxies and rewrites authorization server metadata", async () => {
      mockConnectionWithAuthServer(
        { connection_url: "https://origin.example.com/mcp" },
        new Response(
          JSON.stringify({
            resource: "https://origin.example.com/mcp",
            authorization_servers: ["https://origin.example.com"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const res = await app.request(
        "http://localhost:3000/.well-known/oauth-authorization-server/oauth-proxy/conn_123",
      );

      expect(res.status).toBe(200);
      const body = await res.json();

      // Endpoints are rewritten under the org-scoped mount so DCR / token /
      // authorize benefit from `resolveOrgFromPath` cross-org enforcement.
      expect(body.authorization_endpoint).toBe(
        `http://localhost:3000/api/${TEST_ORG_SLUG}/oauth-proxy/conn_123/authorize`,
      );
      expect(body.token_endpoint).toBe(
        `http://localhost:3000/api/${TEST_ORG_SLUG}/oauth-proxy/conn_123/token`,
      );
      expect(body.registration_endpoint).toBe(
        `http://localhost:3000/api/${TEST_ORG_SLUG}/oauth-proxy/conn_123/register`,
      );
      // Should preserve issuer
      expect(body.issuer).toBe("https://origin.example.com");
    });

    test("falls back to legacy proxy path when connection has no resolvable org slug", async () => {
      // Defensive: orphaned connections (org row missing) keep working via the
      // legacy mount instead of emitting `/api//oauth-proxy/...` URLs.
      mockConnectionWithAuthServer(
        { connection_url: "https://origin.example.com/mcp" },
        new Response(
          JSON.stringify({
            resource: "https://origin.example.com/mcp",
            authorization_servers: ["https://origin.example.com"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
        null, // org lookup returns no slug
      );

      const res = await app.request(
        "http://localhost:3000/.well-known/oauth-authorization-server/oauth-proxy/conn_123",
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { authorization_endpoint: string };
      expect(body.authorization_endpoint).toBe(
        "http://localhost:3000/oauth-proxy/conn_123/authorize",
      );
    });

    test("handles root path auth server without trailing slash", async () => {
      // When auth server is at root (https://example.com), the well-known URL
      // should be /.well-known/oauth-authorization-server (no trailing slash)
      mockConnectionWithAuthServer(
        { connection_url: "https://origin.example.com/mcp" },
        new Response(
          JSON.stringify({
            resource: "https://origin.example.com/mcp",
            // Auth server at root path
            authorization_servers: ["https://auth.example.com"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      let fetchedUrl: string | null = null;
      global.fetch = mock((url: string) => {
        if (url.includes("oauth-protected-resource")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                authorization_servers: ["https://auth.example.com"],
              }),
              { status: 200 },
            ),
          );
        }
        // Capture the auth server metadata URL
        fetchedUrl = url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              authorization_endpoint: "https://auth.example.com/authorize",
            }),
            { status: 200 },
          ),
        );
      }) as unknown as typeof fetch;

      await app.request(
        "http://localhost:3000/.well-known/oauth-authorization-server/oauth-proxy/conn_123",
      );

      // Should NOT have trailing slash
      expect(fetchedUrl).toBeTruthy();
      expect(
        (fetchedUrl ?? "").includes(".well-known/oauth-authorization-server"),
      ).toBe(true);
      expect((fetchedUrl ?? "").endsWith("/")).toBe(false);
    });

    test("handles non-root path auth server correctly", async () => {
      mockConnectionWithAuthServer(
        { connection_url: "https://origin.example.com/mcp" },
        new Response(
          JSON.stringify({
            authorization_servers: ["https://auth.example.com/oauth"],
          }),
          { status: 200 },
        ),
      );

      let fetchedUrl: string | null = null;
      global.fetch = mock((url: string) => {
        if (url.includes("oauth-protected-resource")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                authorization_servers: ["https://auth.example.com/oauth"],
              }),
              { status: 200 },
            ),
          );
        }
        fetchedUrl = url;
        return Promise.resolve(
          new Response(JSON.stringify({}), { status: 200 }),
        );
      }) as unknown as typeof fetch;

      await app.request(
        "http://localhost:3000/.well-known/oauth-authorization-server/oauth-proxy/conn_123",
      );

      // Should append the path
      expect(fetchedUrl).toBeTruthy();
      expect(
        (fetchedUrl ?? "").includes(
          ".well-known/oauth-authorization-server/oauth",
        ),
      ).toBe(true);
    });
  });
});

describe("OAuth URL Path Construction", () => {
  test("root path results in no suffix", () => {
    const authServerUrl = new URL("https://example.com/");
    const authServerPath =
      authServerUrl.pathname === "/" ? "" : authServerUrl.pathname;
    const result = `/.well-known/oauth-authorization-server${authServerPath}`;

    expect(result).toBe("/.well-known/oauth-authorization-server");
    expect(result).not.toEndWith("/");
  });

  test("non-root path is appended correctly", () => {
    const authServerUrl = new URL("https://example.com/oauth");
    const authServerPath =
      authServerUrl.pathname === "/" ? "" : authServerUrl.pathname;
    const result = `/.well-known/oauth-authorization-server${authServerPath}`;

    expect(result).toBe("/.well-known/oauth-authorization-server/oauth");
  });

  test("deep path is appended correctly", () => {
    const authServerUrl = new URL("https://example.com/v1/oauth/server");
    const authServerPath =
      authServerUrl.pathname === "/" ? "" : authServerUrl.pathname;
    const result = `/.well-known/oauth-authorization-server${authServerPath}`;

    expect(result).toBe(
      "/.well-known/oauth-authorization-server/v1/oauth/server",
    );
  });
});

describe("Deco-Hosted MCP Detection", () => {
  test("DECO_CMS_API_HOST is correct", () => {
    expect(DECO_CMS_API_HOST).toBe("api.decocms.com");
  });

  test("DECO_STORE_URL is correct", () => {
    expect(DECO_STORE_URL).toBe(
      "https://studio.decocms.com/org/deco/registry/mcp",
    );
  });

  describe("isDecoHostedMcp", () => {
    test("returns true for deco-hosted MCP URLs", () => {
      expect(
        isDecoHostedMcp("https://api.decocms.com/apps/deco/github/mcp"),
      ).toBe(true);
      expect(isDecoHostedMcp("https://api.decocms.com/mcp/some-app")).toBe(
        true,
      );
      expect(isDecoHostedMcp("https://api.decocms.com/apps/xyz/abc/mcp")).toBe(
        true,
      );
    });

    test("returns false for Deco Store registry (public, no OAuth)", () => {
      expect(isDecoHostedMcp(DECO_STORE_URL)).toBe(false);
    });

    test("returns false for non-deco-hosted URLs", () => {
      expect(isDecoHostedMcp("https://stripe.mcp.run/mcp")).toBe(false);
      expect(isDecoHostedMcp("https://mcp.example.com/api")).toBe(false);
      expect(isDecoHostedMcp("https://other.decocms.com/mcp")).toBe(false);
    });

    test("returns false for null or invalid URLs", () => {
      expect(isDecoHostedMcp(null)).toBe(false);
      expect(isDecoHostedMcp("")).toBe(false);
      expect(isDecoHostedMcp("not-a-url")).toBe(false);
    });
  });
});
