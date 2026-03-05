/**
 * MCP OAuth Proxy E2E Tests
 *
 * Tests the Mesh OAuth proxy against real MCP servers.
 * All servers in mcp-test-servers.json must pass all tests.
 *
 * Run with: bun test oauth-proxy.e2e.test.ts
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  spyOn,
  mock,
} from "bun:test";
import {
  createDatabase,
  closeDatabase,
  type MeshDatabase,
} from "../../database";
import { createTestSchema } from "../../storage/test-helpers";
import { createApp } from "../app";
import type { EventBus } from "../../event-bus";
import { auth } from "../../auth";

// =============================================================================
// Test Data
// =============================================================================

/** MCP servers that support OAuth - all should pass OAuth discovery tests */
const MCP_SERVERS = [
  { url: "https://mcp.stripe.com/", name: "Stripe" },
  { url: "https://sites-openrouter.decocache.com/mcp", name: "OpenRouter" },
  { url: "https://api.decocms.com/apps/deco/github/mcp", name: "Deco GitHub" },
  {
    url: "https://server.smithery.ai/@exa-labs/exa-code-mcp/mcp",
    name: "Smithery",
  },
  { url: "https://mcp.notion.com/mcp", name: "Notion" },
  { url: "https://api.githubcopilot.com/mcp/", name: "GitHub Copilot" },
  { url: "https://mcp.vercel.com", name: "Vercel" },
  { url: "https://mcp.prisma.io/mcp", name: "Prisma" },
  { url: "https://mcp.supabase.com/mcp", name: "Supabase" },
  { url: "https://api.grain.com/_/mcp", name: "Grain" },
  { url: "https://mcp.apify.com/", name: "Apify" },
  { url: "https://mcp.postman.com/mcp", name: "Postman" },
];

/** MCP servers that DON'T support OAuth - should return 401 without WWW-Authenticate */
const NO_OAUTH_SERVERS: { url: string; name: string }[] = [];

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
}

interface AuthServerMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
}

// =============================================================================
// Test Setup
// =============================================================================

function createMockEventBus(): EventBus {
  return {
    start: async () => {},
    stop: () => {},
    isRunning: () => false,
    publish: async () => ({}) as never,
    subscribe: async () => ({}) as never,
    unsubscribe: async () => ({ success: true }),
    listSubscriptions: async () => [],
    getSubscription: async () => null,
    getEvent: async () => null,
    cancelEvent: async () => ({ success: true }),
    ackEvent: async () => ({ success: true }),
    syncSubscriptions: async () => ({
      created: 0,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      subscriptions: [],
    }),
  };
}

const TEST_ORG_ID = "org_test";
const TEST_AUTH_HEADERS = {
  Authorization: "Bearer test-api-key",
};

let database: MeshDatabase;
let app: Awaited<ReturnType<typeof createApp>>;
const connectionMap = new Map<string, string>();

describe("MCP OAuth Proxy E2E", () => {
  beforeAll(async () => {
    // Restore all mocks in case other tests mocked global.fetch
    mock.restore();

    database = createDatabase(":memory:");
    await createTestSchema(database.db);
    app = await createApp({ database, eventBus: createMockEventBus() });

    // Mock auth to allow authenticated requests
    spyOn(auth.api, "getMcpSession").mockResolvedValue(null);
    spyOn(auth.api, "verifyApiKey").mockResolvedValue({
      valid: true,
      error: null,
      key: {
        id: "test-key-id",
        name: "Test API Key",
        userId: "test-user-id",
        permissions: { self: ["COLLECTION_CONNECTIONS_LIST"] },
        metadata: {
          organization: {
            id: TEST_ORG_ID,
            slug: "test-org",
            name: "Test Organization",
          },
        },
      },
    } as never);

    // Create a connection for each MCP server (OAuth-supporting)
    for (const server of MCP_SERVERS) {
      const connectionId = `conn_${server.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
      connectionMap.set(server.url, connectionId);

      await database.db
        .insertInto("connections")
        .values({
          id: connectionId,
          organization_id: TEST_ORG_ID,
          created_by: "test_user",
          title: server.name,
          connection_type: "HTTP",
          connection_url: server.url,
          status: "active",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .execute();
    }

    // Create connections for non-OAuth servers
    for (const server of NO_OAUTH_SERVERS) {
      const connectionId = `conn_${server.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
      connectionMap.set(server.url, connectionId);

      await database.db
        .insertInto("connections")
        .values({
          id: connectionId,
          organization_id: TEST_ORG_ID,
          created_by: "test_user",
          title: server.name,
          connection_type: "HTTP",
          connection_url: server.url,
          status: "active",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .execute();
    }
  });

  afterAll(async () => {
    await closeDatabase(database);
  });

  // ===========================================================================
  // Access Control - Auth & Organization checks (IDOR protection)
  // ===========================================================================

  describe("Access Control", () => {
    test("returns 401 for unauthenticated requests", async () => {
      const connectionId = connectionMap.get(MCP_SERVERS[0]!.url)!;

      // Temporarily override the mock to simulate unauthenticated request
      const verifyMock = spyOn(auth.api, "verifyApiKey").mockResolvedValue({
        valid: false,
        error: "Invalid key",
        key: null,
      } as never);

      const res = await app.request(
        `/oauth-proxy/${connectionId}/authorize?response_type=code&client_id=test&state=test`,
        { redirect: "manual" },
      );

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Unauthorized");

      // Restore the original mock for subsequent tests
      verifyMock.mockResolvedValue({
        valid: true,
        error: null,
        key: {
          id: "test-key-id",
          name: "Test API Key",
          userId: "test-user-id",
          permissions: { self: ["COLLECTION_CONNECTIONS_LIST"] },
          metadata: {
            organization: {
              id: TEST_ORG_ID,
              slug: "test-org",
              name: "Test Organization",
            },
          },
        },
      } as never);
    });

    test("returns 404 for non-existent connection", async () => {
      const res = await app.request(
        `/oauth-proxy/conn_nonexistent/authorize?response_type=code&client_id=test&state=test`,
        {
          redirect: "manual",
          headers: TEST_AUTH_HEADERS,
        },
      );

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Connection not found");
    });

    test("returns 403 for cross-organization connection access (IDOR protection)", async () => {
      // Create a connection belonging to a different organization
      const crossOrgConnectionId = "conn_cross_org";
      await database.db
        .insertInto("connections")
        .values({
          id: crossOrgConnectionId,
          organization_id: "org_other", // Different from TEST_ORG_ID
          created_by: "other_user",
          title: "Cross Org Server",
          connection_type: "HTTP",
          connection_url: "https://example.com/mcp",
          status: "active",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .execute();

      const res = await app.request(
        `/oauth-proxy/${crossOrgConnectionId}/authorize?response_type=code&client_id=test&state=test`,
        {
          redirect: "manual",
          headers: TEST_AUTH_HEADERS,
        },
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe(
        "Connection does not belong to your organization",
      );
    });

    test("returns 403 for cross-org token endpoint access", async () => {
      const res = await app.request(`/oauth-proxy/conn_cross_org/token`, {
        method: "POST",
        headers: {
          ...TEST_AUTH_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=authorization_code&code=test_code",
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe(
        "Connection does not belong to your organization",
      );
    });

    test("returns 403 for cross-org register endpoint access", async () => {
      const res = await app.request(`/oauth-proxy/conn_cross_org/register`, {
        method: "POST",
        headers: {
          ...TEST_AUTH_HEADERS,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_name: "malicious-client",
          redirect_uris: ["https://evil.com/callback"],
        }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe(
        "Connection does not belong to your organization",
      );
    });
  });

  // ===========================================================================
  // Step 1: Protected Resource Metadata Discovery
  // ===========================================================================

  describe("Protected Resource Metadata", () => {
    for (const server of MCP_SERVERS) {
      test(`${server.name} - discovery and URL rewriting`, async () => {
        const connectionId = connectionMap.get(server.url)!;
        const res = await app.request(
          `/.well-known/oauth-protected-resource/mcp/${connectionId}`,
        );

        expect(res.status).toBe(200);

        const metadata: ProtectedResourceMetadata = await res.json();

        // Must have authorization_servers pointing to our proxy
        expect(metadata.authorization_servers).toBeDefined();
        expect(metadata.authorization_servers!.length).toBeGreaterThan(0);

        const authServer = metadata.authorization_servers![0];
        expect(authServer).toContain(`oauth-proxy/${connectionId}`);
      });
    }
  });

  // ===========================================================================
  // Step 2: Authorization Server Metadata Discovery
  // ===========================================================================

  describe("Auth Server Metadata", () => {
    for (const server of MCP_SERVERS) {
      test(`${server.name} - discovery and endpoint rewriting`, async () => {
        const connectionId = connectionMap.get(server.url)!;
        const res = await app.request(
          `/.well-known/oauth-authorization-server/oauth-proxy/${connectionId}`,
        );

        expect(res.status).toBe(200);

        const metadata: AuthServerMetadata = await res.json();

        // Must have key OAuth endpoints
        expect(metadata.authorization_endpoint).toBeDefined();
        expect(metadata.token_endpoint).toBeDefined();

        // Endpoints must be rewritten to point to our proxy
        expect(metadata.authorization_endpoint).toContain(
          `oauth-proxy/${connectionId}`,
        );
        expect(metadata.token_endpoint).toContain(
          `oauth-proxy/${connectionId}`,
        );
      });
    }
  });

  // ===========================================================================
  // Step 3: Authorize Endpoint (must redirect, not proxy HTML)
  // ===========================================================================

  describe("Authorize Endpoint", () => {
    for (const server of MCP_SERVERS) {
      test(`${server.name} - must redirect, not proxy HTML`, async () => {
        const connectionId = connectionMap.get(server.url)!;
        const res = await app.request(
          `/oauth-proxy/${connectionId}/authorize?response_type=code&client_id=test&state=test`,
          {
            redirect: "manual",
            headers: TEST_AUTH_HEADERS,
          },
        );

        // Must be a redirect (302)
        expect(res.status).toBe(302);

        // Must NOT return HTML (that was the Vercel bug)
        const contentType = res.headers.get("content-type") || "";
        expect(contentType.includes("text/html")).toBe(false);

        // Location header must point to origin's authorize endpoint
        const location = res.headers.get("location");
        expect(location).toBeDefined();
        expect(location).not.toContain("oauth-proxy"); // Should be origin URL
      });
    }

    for (const server of MCP_SERVERS) {
      test(`${server.name} - must rewrite resource param to origin URL`, async () => {
        const connectionId = connectionMap.get(server.url)!;
        // Pass a proxy resource URL - this is what clients send
        const proxyResourceUrl = `http://localhost/mcp/${connectionId}`;
        const res = await app.request(
          `/oauth-proxy/${connectionId}/authorize?response_type=code&client_id=test&state=test&resource=${encodeURIComponent(proxyResourceUrl)}`,
          {
            redirect: "manual",
            headers: TEST_AUTH_HEADERS,
          },
        );

        expect(res.status).toBe(302);

        const location = res.headers.get("location");
        expect(location).toBeDefined();

        // Parse the redirect URL and check the resource param
        const redirectUrl = new URL(location!);
        const resourceParam = redirectUrl.searchParams.get("resource");

        // Resource param MUST be rewritten to the origin server URL, not our proxy
        // This is critical for auth servers like Supabase that validate the resource
        expect(resourceParam).toBeDefined();
        expect(resourceParam).toBe(server.url);
        expect(resourceParam).not.toContain("oauth-proxy");
        expect(resourceParam).not.toContain(connectionId);
      });
    }
  });

  // ===========================================================================
  // Servers without OAuth support - should return 401 without WWW-Authenticate
  // ===========================================================================

  describe("Non-OAuth Servers", () => {
    for (const server of NO_OAUTH_SERVERS) {
      test(`${server.name} - returns 401 without WWW-Authenticate`, async () => {
        const connectionId = connectionMap.get(server.url)!;

        // Try to access the MCP endpoint with auth - should get 401 from origin without WWW-Authenticate
        const res = await app.request(`/mcp/${connectionId}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: "Bearer test-api-key", // Triggers our mock auth
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "test", version: "1.0.0" },
            },
          }),
        });

        // Should be 401 (from origin, proxied through our system)
        expect(res.status).toBe(401);

        // Should NOT have WWW-Authenticate header (server doesn't support OAuth)
        const wwwAuth = res.headers.get("WWW-Authenticate");
        expect(wwwAuth).toBeNull();

        // Should have JSON error body
        const body = await res.json();
        expect(body.error).toBe("unauthorized");
      });
    }
  });
});
