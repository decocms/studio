import { describe, it, expect, beforeAll, afterAll, vi } from "bun:test";
import {
  createTestDatabase,
  closeTestDatabase,
  type TestDatabase,
} from "../../database/test-db";
import {
  createTestSchema,
  seedCommonTestFixtures,
} from "../../storage/test-helpers";
import { CredentialVault } from "../../encryption/credential-vault";
import {
  COLLECTION_CONNECTIONS_CREATE,
  COLLECTION_CONNECTIONS_LIST,
  COLLECTION_CONNECTIONS_GET,
  COLLECTION_CONNECTIONS_UPDATE,
  CONNECTION_TEST,
} from "./index";
import type { BoundAuthClient, MeshContext } from "../../core/mesh-context";
import { ConnectionStorage } from "../../storage/connection";
import { DownstreamTokenStorage } from "../../storage/downstream-token";
import type { EventBus } from "../../event-bus/interface";
import * as fetchToolsModule from "./fetch-tools";

// Create a mock BoundAuthClient for tests
const createMockBoundAuth = (): BoundAuthClient =>
  ({
    hasPermission: vi.fn().mockResolvedValue(true),
    organization: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      addMember: vi.fn(),
      removeMember: vi.fn(),
      listMembers: vi.fn(),
      updateMemberRole: vi.fn(),
    },
  }) as unknown as BoundAuthClient;

describe("Connection Tools", () => {
  let database: TestDatabase;
  let ctx: MeshContext;
  let vault: CredentialVault;

  beforeAll(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);

    vault = new CredentialVault(CredentialVault.generateKey());

    // Create mock context
    ctx = {
      timings: {
        measure: async <T>(_name: string, cb: () => Promise<T>) => await cb(),
      },
      auth: {
        user: {
          id: "user_1",
          email: "[email protected]",
          name: "Test",
          role: "admin",
        },
      },
      organization: {
        id: "org_123",
        slug: "test-org",
        name: "Test Organization",
      },
      storage: {
        connections: new ConnectionStorage(database.db, vault),
        organizationSettings: {
          get: async () => null,
          upsert: async (_orgId: string) => ({
            organizationId: _orgId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        } as never,
        monitoring: null as never,
        threads: null as never,
        virtualMcps: null as never,
        users: null as never,
        tags: null as never,
        projects: null as never,
        projectConnections: null as never,
        projectPluginConfigs: null as never,
        monitoringDashboards: null as never,
        aiProviderKeys: null as never,
        oauthPkceStates: null as never,
        automations: null as never,
        orgSsoConfig: null as never,
        orgSsoSessions: null as never,
      },
      vault,
      authInstance: null as never,
      boundAuth: createMockBoundAuth(),
      access: {
        granted: () => true,
        check: async () => {},
        grant: () => {},
        setToolName: () => {},
      } as never,
      db: database.db,
      tracer: {
        startActiveSpan: (
          _name: string,
          _opts: unknown,
          fn: (span: unknown) => unknown,
        ) =>
          fn({
            setStatus: () => {},
            recordException: () => {},
            end: () => {},
          }),
      } as never,
      meter: {
        createHistogram: () => ({ record: () => {} }),
        createCounter: () => ({ add: () => {} }),
      } as never,
      baseUrl: "https://mesh.example.com",
      metadata: {
        requestId: "req_123",
        timestamp: new Date(),
      },
      eventBus: {
        publish: vi.fn().mockResolvedValue({}),
        subscribe: vi.fn().mockResolvedValue({}),
        unsubscribe: vi.fn().mockResolvedValue({ success: true }),
        listSubscriptions: vi.fn().mockResolvedValue([]),
        getSubscription: vi.fn().mockResolvedValue(null),
        start: vi.fn(),
        stop: vi.fn(),
        isRunning: vi.fn().mockReturnValue(false),
      } as unknown as EventBus,
      aiProviders: null as never,
      createMCPProxy: vi.fn().mockResolvedValue({}),
      getOrCreateClient: vi.fn().mockResolvedValue({}),
    };
  });

  afterAll(async () => {
    await closeTestDatabase(database);
  });

  describe("COLLECTION_CONNECTIONS_CREATE", () => {
    it("should create organization-scoped connection", async () => {
      const result = await COLLECTION_CONNECTIONS_CREATE.execute(
        {
          data: {
            title: "Company Slack",
            description: "Organization-wide Slack",
            connection_type: "HTTP",
            connection_url: "https://slack.com/mcp",
            connection_token: "slack-token",
          },
        },
        ctx,
      );

      expect(result.item.id).toMatch(/^conn_/);
      expect(result.item.title).toBe("Company Slack");
      expect(result.item.organization_id).toBe("org_123");
      expect(result.item.status).toBe("active");
    });
  });

  describe("COLLECTION_CONNECTIONS_UPDATE (OAuth tool refresh)", () => {
    it("should refresh tools using downstream OAuth token when connection_token is not set", async () => {
      const connection = await ctx.storage.connections.create({
        id: "conn_oauth_tools",
        organization_id: "org_123",
        created_by: "user_1",
        title: "OAuth MCP",
        connection_type: "HTTP",
        connection_url: "https://example.com/mcp",
        connection_token: null,
        tools: null,
      });

      const tokenStorage = new DownstreamTokenStorage(database.db, vault);
      await tokenStorage.upsert({
        connectionId: connection.id,
        accessToken: "oauth-access-token",
        refreshToken: null,
        scope: null,
        expiresAt: new Date(Date.now() + 60_000),
        clientId: null,
        clientSecret: null,
        tokenEndpoint: null,
      });

      const fetchSpy = vi
        .spyOn(fetchToolsModule, "fetchToolsFromMCP")
        .mockImplementation(async (input) => {
          expect(input.connection_token).toBe("oauth-access-token");
          return {
            tools: [
              {
                name: "COLLECTION_LLM_LIST",
                description: "List models",
                inputSchema: {},
              },
            ],
            scopes: null,
          };
        });

      const result = await COLLECTION_CONNECTIONS_UPDATE.execute(
        { id: connection.id, data: {} },
        ctx,
      );

      expect(fetchSpy).toHaveBeenCalled();
      expect(
        result.item.tools?.some((t) => t.name === "COLLECTION_LLM_LIST"),
      ).toBe(true);
    });
  });

  describe("COLLECTION_CONNECTIONS_LIST", () => {
    it("should list all connections in organization", async () => {
      const result = await COLLECTION_CONNECTIONS_LIST.execute({}, ctx);

      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.every((c) => c.organization_id === "org_123")).toBe(
        true,
      );
    });

    it("should include connection details", async () => {
      const result = await COLLECTION_CONNECTIONS_LIST.execute({}, ctx);

      const conn = result.items[0];
      expect(conn).toHaveProperty("id");
      expect(conn).toHaveProperty("title");
      expect(conn).toHaveProperty("organization_id");
      expect(conn).toHaveProperty("connection_type");
      expect(conn).toHaveProperty("connection_url");
      expect(conn).toHaveProperty("status");
    });
  });

  describe("COLLECTION_CONNECTIONS_GET", () => {
    it("should get connection by ID", async () => {
      const created = await COLLECTION_CONNECTIONS_CREATE.execute(
        {
          data: {
            title: "Get Test",
            connection_type: "HTTP",
            connection_url: "https://test.com",
          },
        },
        ctx,
      );

      const result = await COLLECTION_CONNECTIONS_GET.execute(
        {
          id: created.item.id,
        },
        ctx,
      );

      expect(result.item?.id).toBe(created.item.id);
      expect(result.item?.title).toBe("Get Test");
    });

    it("should return null when connection not found", async () => {
      const result = await COLLECTION_CONNECTIONS_GET.execute(
        {
          id: "conn_nonexistent",
        },
        ctx,
      );

      expect(result.item).toBeNull();
    });
  });

  describe("COLLECTION_CONNECTIONS_DELETE", () => {
    // Delete test removed - was timing out due to network calls
  });

  describe("CONNECTION_TEST", () => {
    it("should test connection health", async () => {
      const created = await COLLECTION_CONNECTIONS_CREATE.execute(
        {
          data: {
            title: "Test Health",
            connection_type: "HTTP",
            connection_url: "https://this-will-fail.invalid",
          },
        },
        ctx,
      );

      const result = await CONNECTION_TEST.execute(
        {
          id: created.item.id,
        },
        ctx,
      );

      expect(result.id).toBe(created.item.id);
      expect(result).toHaveProperty("healthy");
      expect(result).toHaveProperty("latencyMs");
      expect(typeof result.latencyMs).toBe("number");
    });

    it("should throw when connection not found", async () => {
      await expect(
        CONNECTION_TEST.execute(
          {
            id: "conn_nonexistent",
          },
          ctx,
        ),
      ).rejects.toThrow("Connection not found");
    });
  });
});
