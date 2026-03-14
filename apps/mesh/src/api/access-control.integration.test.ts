/**
 * Access Control Integration Tests
 *
 * Comprehensive tests for the permission model with:
 * - Management API ("self" resource) permissions
 * - Proxy API ("conn_<UUID>" resource) permissions
 * - Cross-organization isolation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import { auth } from "../auth";
import {
  createTestDatabase,
  closeTestDatabase,
  type TestDatabase,
} from "../database/test-db";
import type { EventBus } from "../event-bus";
import { createTestSchema } from "../storage/test-helpers";
import type { Permission } from "../storage/types";
import { createApp } from "./app";

/**
 * Create a no-op mock event bus for testing
 */
function createMockEventBus(): EventBus {
  return {
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
    isRunning: () => false,
    start: async () => {},
    stop: async () => {},
    publish: async () => ({ success: true }) as any,
    subscribe: async () =>
      ({ success: true, subscriptionId: "mock-sub" }) as any,
    unsubscribe: async () => ({ success: true }),
    listSubscriptions: async () => [],
  };
}

// ============================================================================
// Types
// ============================================================================

interface TestUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

interface TestOrganization {
  id: string;
  slug: string;
  name: string;
}

interface TestConnection {
  id: string;
  organizationId: string;
  name: string;
  url: string;
}

interface TestApiKey {
  id: string;
  key: string;
  userId: string;
  permissions: Permission;
}

interface BetterAuthApiKeyResult {
  valid: boolean;
  error: null | { message: string };
  key?: {
    id: string;
    name: string;
    userId: string;
    permissions: Permission;
    metadata?: Record<string, unknown>;
  };
}

interface MCPRequest {
  jsonrpc: "2.0";
  method: string;
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
  id: number;
}

// ============================================================================
// Test State
// ============================================================================

describe("Access Control Integration Tests", () => {
  let database: TestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let testUsers: Map<string, TestUser>;
  let testOrganizations: Map<string, TestOrganization>;
  let testConnections: Map<string, TestConnection>;
  let testApiKeys: Map<string, TestApiKey>;
  let userIdCounter = 1;
  let orgIdCounter = 1;
  let connIdCounter = 1;
  let keyIdCounter = 1;

  // ============================================================================
  // Setup & Teardown
  // ============================================================================

  beforeEach(async () => {
    // Create in-memory database
    database = await createTestDatabase();
    await createTestSchema(database.db);

    // Create app instance with test database and mock event bus
    app = await createApp({ database, eventBus: createMockEventBus() });

    // Initialize test data maps
    testUsers = new Map();
    testOrganizations = new Map();
    testConnections = new Map();
    testApiKeys = new Map();

    // Reset counters
    userIdCounter = 1;
    orgIdCounter = 1;
    connIdCounter = 1;
    keyIdCounter = 1;

    // Mock Better Auth methods
    vi.spyOn(auth.api, "getMcpSession").mockResolvedValue(null);
    vi.spyOn(auth.api, "setActiveOrganization").mockResolvedValue(null as any);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
    vi.restoreAllMocks();
  });

  // ============================================================================
  // Test Helper Functions
  // ============================================================================

  /**
   * Create a test user
   */
  async function createTestUser(
    role: "user" | "admin" = "user",
  ): Promise<TestUser> {
    const id = `user_${userIdCounter++}`;
    const user: TestUser = {
      id,
      email: `${id}@example.com`,
      name: `Test User ${id}`,
      role,
    };

    const now = new Date().toISOString();

    // Insert into Better Auth "user" table (FK target for connections.created_by)
    await database.db
      .insertInto("user" as any)
      .values({
        id: user.id,
        email: user.email,
        emailVerified: 0,
        name: user.name,
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    // Insert into application "users" table
    await database.db
      .insertInto("users")
      .values({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    testUsers.set(user.id, user);
    return user;
  }

  /**
   * Create a test organization
   */
  async function createTestOrganization(): Promise<TestOrganization> {
    const id = `org_${orgIdCounter++}`;
    const org: TestOrganization = {
      id,
      slug: `test-org-${id}`,
      name: `Test Organization ${id}`,
    };

    await database.db
      .insertInto("organization" as any)
      .values({
        id: org.id,
        name: org.name,
        slug: org.slug,
        createdAt: new Date().toISOString(),
      })
      .execute();

    testOrganizations.set(org.id, org);
    return org;
  }

  /**
   * Create a test connection in an organization
   */
  async function createTestConnection(
    organizationId: string,
    userId: string,
  ): Promise<TestConnection> {
    const id = `conn_${connIdCounter++}`;
    const connection: TestConnection = {
      id,
      organizationId,
      name: `Test Connection ${id}`,
      url: `https://example.com/mcp/${id}`,
    };

    // Insert directly into database
    await database.db
      .insertInto("connections")
      .values({
        id: connection.id,
        organization_id: connection.organizationId,
        created_by: userId,
        title: connection.name,
        description: null,
        icon: null,
        app_name: null,
        app_id: null,
        connection_type: "HTTP",
        connection_url: connection.url,
        connection_token: null,
        connection_headers: null,
        oauth_config: null,
        metadata: null,
        tools: null,
        bindings: null,
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();

    testConnections.set(connection.id, connection);
    return connection;
  }

  /**
   * Create an API key with specific permissions
   */
  async function createApiKeyWithPermissions(
    userId: string,
    permissions: Permission,
    organizationId?: string,
  ): Promise<TestApiKey> {
    const id = `key_${keyIdCounter++}`;
    const key = `test_api_key_${id}_${Math.random().toString(36).substring(7)}`;

    const apiKey: TestApiKey = {
      id,
      key,
      userId,
      permissions,
    };

    // Store for verification
    testApiKeys.set(key, apiKey);

    // Update mock to handle this key
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(auth.api, "verifyApiKey").mockImplementation((async (params: {
      body: { key: string };
    }) => {
      const requestedKey = params.body.key;
      const storedKey = testApiKeys.get(requestedKey);

      if (storedKey) {
        const org = organizationId
          ? testOrganizations.get(organizationId)
          : undefined;
        const metadata = org ? { organization: org } : {};
        return {
          valid: true,
          error: null,
          key: {
            id: storedKey.id,
            name: `API Key ${storedKey.id}`,
            userId: storedKey.userId,
            permissions: storedKey.permissions,
            metadata,
          },
        } as BetterAuthApiKeyResult;
      }

      return {
        valid: false,
        error: { message: "Invalid API key" },
      } as BetterAuthApiKeyResult;
    }) as never);

    return apiKey;
  }

  /**
   * Make an MCP request to management API
   */
  async function makeMcpRequest(
    apiKey: string,
    toolName: string,
    toolArgs: Record<string, unknown> = {},
  ): Promise<Response> {
    const mcpRequest: MCPRequest = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: toolName,
        arguments: toolArgs,
      },
      id: 1,
    };

    return await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      body: JSON.stringify(mcpRequest),
    });
  }

  /**
   * Make an MCP request to proxy API (connection-specific)
   */
  async function makeMcpProxyRequest(
    apiKey: string,
    connectionId: string,
    toolName: string,
    toolArgs: Record<string, unknown> = {},
  ): Promise<Response> {
    const mcpRequest: MCPRequest = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: toolName,
        arguments: toolArgs,
      },
      id: 1,
    };

    return await app.request(`/mcp/${connectionId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      body: JSON.stringify(mcpRequest),
    });
  }

  // ============================================================================
  // Management API Tests - "self" resource
  // ============================================================================

  describe("Management API - 'self' resource", () => {
    it("should allow access to management tools with 'self' permission", async () => {
      const user = await createTestUser();
      const org = await createTestOrganization();

      const apiKey = await createApiKeyWithPermissions(
        user.id,
        {
          self: [
            "COLLECTION_CONNECTIONS_CREATE",
            "COLLECTION_CONNECTIONS_LIST",
          ],
        },
        org.id,
      );

      const response = await makeMcpRequest(
        apiKey.key,
        "COLLECTION_CONNECTIONS_CREATE",
        {
          data: {
            title: "Test Connection",
            connection_type: "HTTP",
            connection_url: "https://test.example.com",
          },
        },
      );

      // Authorization should not block the request
      // The request may fail for other reasons (MCP protocol, etc.) but not authorization
      const responseText = await response.text();
      expect(responseText).not.toContain("Access denied");
      expect(responseText).not.toContain("Authorization failed");
      expect(responseText).not.toContain("Authentication required");
    });

    it("should allow admin role to bypass permission checks", async () => {
      const adminUser = await createTestUser("admin");
      const org = await createTestOrganization();

      // Create API key with empty permissions (admin should bypass)
      const apiKey = await createApiKeyWithPermissions(
        adminUser.id,
        {},
        org.id,
      );

      const response = await makeMcpRequest(
        apiKey.key,
        "COLLECTION_CONNECTIONS_CREATE",
        {
          data: {
            title: "Admin Connection",
            connection_type: "HTTP",
            connection_url: "https://admin.example.com",
          },
        },
      );

      const responseText = await response.text();
      // Admin bypass should allow access (no access denied error)
      expect(responseText).not.toContain("Access denied");
      expect(responseText).not.toContain("Authorization failed");
    });
  });

  // ============================================================================
  // Proxy API Tests - "conn_<UUID>" resource
  // ============================================================================

  describe("Proxy API - 'conn_<UUID>' resource", () => {
    it("should allow access to tool on specific connection when granted", async () => {
      const user = await createTestUser();
      const org = await createTestOrganization();
      const connection = await createTestConnection(org.id, user.id);

      const apiKey = await createApiKeyWithPermissions(
        user.id,
        {
          [connection.id]: ["SEND_MESSAGE"],
        },
        org.id,
      );

      const response = await makeMcpProxyRequest(
        apiKey.key,
        connection.id,
        "SEND_MESSAGE",
        {
          content: "Hello, world!",
        },
      );

      // We expect this to fail on the actual proxy (connection doesn't exist)
      // but it should pass authorization (not 403)
      // Could be 404 (connection not properly configured) or 500 (proxy error)
      expect(response.status).not.toBe(403);
    });
  });

  // ============================================================================
  // Cross-Organization Isolation Tests
  // ============================================================================

  describe("Cross-Organization Isolation", () => {
    it("should prevent access to connection from different organization", async () => {
      const user = await createTestUser();

      // Create org A with connection A
      const orgA = await createTestOrganization();
      const connectionA = await createTestConnection(orgA.id, user.id);

      // Create org B with connection B
      const orgB = await createTestOrganization();
      const connectionB = await createTestConnection(orgB.id, user.id);

      // Create API key for user with permission for connection A in org A context
      const apiKey = await createApiKeyWithPermissions(
        user.id,
        {
          [connectionA.id]: ["SEND_MESSAGE"],
        },
        orgA.id, // User's context is org A
      );

      // Try to access connection B (from org B)
      const response = await makeMcpProxyRequest(
        apiKey.key,
        connectionB.id,
        "SEND_MESSAGE",
        {},
      );

      // Should fail - either 403 (unauthorized) or 404 (not found in org context)
      expect([403, 404]).toContain(response.status);
    });

    it("should enforce organization boundaries in connection lookup", async () => {
      const user = await createTestUser();

      // Create org A
      const orgA = await createTestOrganization();
      const connectionA = await createTestConnection(orgA.id, user.id);

      // Create org B
      const orgB = await createTestOrganization();

      // Create API key with permission for connection A but user in org B context
      const apiKey = await createApiKeyWithPermissions(
        user.id,
        {
          [connectionA.id]: ["*"], // Wildcard permission
        },
        orgB.id, // User context is org B, but connection is in org A
      );

      // Try to access connection A from org B context
      const response = await makeMcpProxyRequest(
        apiKey.key,
        connectionA.id,
        "SEND_MESSAGE",
        {},
      );

      // Should fail because connection lookup filters by organization
      expect(response.status).toBe(404);
    });

    it("should verify organization boundary in connection lookup", async () => {
      const user = await createTestUser();

      // Create org A with connection A
      const orgA = await createTestOrganization();
      const connectionA = await createTestConnection(orgA.id, user.id);

      // Create org B with connection B (different ID)
      const orgB = await createTestOrganization();
      const connectionB = await createTestConnection(orgB.id, user.id);

      // Create API key with org A context and permission for connection A
      const apiKey = await createApiKeyWithPermissions(
        user.id,
        {
          [connectionA.id]: ["SEND_MESSAGE"],
        },
        orgA.id,
      );

      // Verify: Connection lookup should filter by organization
      // Connection A should be visible (same org)
      const connectionsA = await database.db
        .selectFrom("connections")
        .selectAll()
        .where("id", "=", connectionA.id)
        .where("organization_id", "=", orgA.id)
        .execute();

      expect(connectionsA.length).toBe(1);
      expect(connectionsA[0]?.organization_id).toBe(orgA.id);

      // Connection B should not be accessible from org A context
      const connectionsB = await database.db
        .selectFrom("connections")
        .selectAll()
        .where("id", "=", connectionB.id)
        .where("organization_id", "=", orgA.id) // Wrong org!
        .execute();

      expect(connectionsB.length).toBe(0); // Not found in org A

      // Make request to connection A (should work - same org)
      const responseA = await makeMcpProxyRequest(
        apiKey.key,
        connectionA.id,
        "SEND_MESSAGE",
        {},
      );

      // Should not fail authorization (may fail on proxy, but not 403)
      expect(responseA.status).not.toBe(403);
    });

    it("should not leak connection existence across organizations", async () => {
      const user = await createTestUser();

      // Create org A (user has access)
      const orgA = await createTestOrganization();

      // Create org B with connection (user does NOT have access)
      const orgB = await createTestOrganization();
      const secretConnection = await createTestConnection(orgB.id, user.id);

      // Create API key with org A context, NO permissions for secret connection
      const apiKey = await createApiKeyWithPermissions(
        user.id,
        {
          self: ["COLLECTION_CONNECTIONS_LIST"],
        },
        orgA.id,
      );

      // Try to access secret connection from org B
      const response = await makeMcpProxyRequest(
        apiKey.key,
        secretConnection.id,
        "SEND_MESSAGE",
        {},
      );

      // Should return 404 (not found) rather than 403 (forbidden)
      // This prevents leaking the existence of the connection
      expect(response.status).toBe(404);
    });
  });
});
