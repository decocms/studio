/* oxlint-disable no-explicit-any */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { type Meter, trace } from "@opentelemetry/api";
import {
  createTestDatabase,
  closeTestDatabase,
  type TestDatabase,
} from "../database/test-db";
import { createTestSchema } from "../storage/test-helpers";
import { createMeshContextFactory } from "./context-factory";
import type { BetterAuthInstance } from "./mesh-context";
import type { EventBus } from "../event-bus/interface";

// Mock EventBus
const createMockEventBus = (): EventBus => ({
  publish: vi.fn().mockResolvedValue({}),
  subscribe: vi.fn().mockResolvedValue({}),
  unsubscribe: vi.fn().mockResolvedValue({ success: true }),
  listSubscriptions: vi.fn().mockResolvedValue([]),
  getSubscription: vi.fn().mockResolvedValue(null),
  getEvent: vi.fn().mockResolvedValue(null),
  cancelEvent: vi.fn().mockResolvedValue({ success: true }),
  ackEvent: vi.fn().mockResolvedValue({ success: true }),
  syncSubscriptions: vi.fn().mockResolvedValue({
    created: 0,
    updated: 0,
    deleted: 0,
    unchanged: 0,
    subscriptions: [],
  }),
  start: vi.fn(),
  stop: vi.fn(),
  isRunning: vi.fn().mockReturnValue(false),
});

describe("createMeshContextFactory", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
  });

  afterAll(async () => {
    await closeTestDatabase(database);
  });

  // Helper to create a mock Request object (factory expects Request, not Hono context)
  const createMockRequest = (options?: {
    url?: string;
    headers?: Record<string, string>;
  }): Request => {
    const url = options?.url ?? "https://mesh.example.com/mcp/tools";
    const headers = new Headers(
      options?.headers ?? {
        Authorization: "Bearer test_key",
      },
    );
    return new Request(url, { headers });
  };

  const createMockAuth = (): any => ({
    api: {
      getMcpSession: vi.fn().mockResolvedValue(null) as any,
      verifyApiKey: vi.fn().mockResolvedValue({
        valid: true,
        key: {
          id: "key_1",
          name: "Test Key",
          userId: "user_1",
          permissions: { self: ["COLLECTION_CONNECTIONS_LIST"] },
          metadata: {
            organization: {
              id: "org_123",
              slug: "test-org",
              name: "Test Organization",
            },
          },
        },
      }),
      setActiveOrganization: vi.fn().mockResolvedValue(null),
    },
  });

  describe("factory creation", () => {
    it("should create context factory function", async () => {
      const factory = await createMeshContextFactory({
        db: database.db,

        auth: createMockAuth() as unknown as BetterAuthInstance,
        encryption: { key: "test_key" },
        observability: {
          tracer: trace.getTracer("test"),
          meter: {} as unknown as Meter,
        },
        eventBus: createMockEventBus(),
      });

      expect(typeof factory).toBe("function");
    });
  });

  // Create mock auth with minimal API for unauthenticated requests
  const createMinimalMockAuth = (): any => ({
    api: {
      getMcpSession: vi.fn().mockResolvedValue(null),
      verifyApiKey: vi.fn().mockResolvedValue({ valid: false }),
      getSession: vi.fn().mockResolvedValue(null),
    },
  });

  describe("MeshContext creation", () => {
    it("should create MeshContext from Request", async () => {
      const factory = await createMeshContextFactory({
        db: database.db,

        auth: createMinimalMockAuth() as unknown as BetterAuthInstance,
        encryption: { key: "test_key" },
        observability: {
          tracer: trace.getTracer("test"),
          meter: {} as unknown as Meter,
        },
        eventBus: createMockEventBus(),
      });

      const request = createMockRequest({
        url: "https://mesh.example.com/mcp/tools",
        headers: {}, // No Authorization
      });

      const meshCtx = await factory(request);

      expect(meshCtx).toBeDefined();
      expect(meshCtx.auth).toBeDefined();
      expect(meshCtx.storage).toBeDefined();
      expect(meshCtx.access).toBeDefined();
      expect(meshCtx.baseUrl).toBe("https://mesh.example.com");
      expect(meshCtx.metadata.requestId).toBeDefined();
    });

    it("should derive base URL from request", async () => {
      const factory = await createMeshContextFactory({
        db: database.db,

        auth: createMinimalMockAuth() as unknown as BetterAuthInstance,
        encryption: { key: "test_key" },
        observability: {
          tracer: trace.getTracer("test"),
          meter: {} as unknown as Meter,
        },
        eventBus: createMockEventBus(),
      });

      const request = createMockRequest({
        url: "http://localhost:3000/mcp/tools",
        headers: {},
      });

      const meshCtx = await factory(request);

      expect(meshCtx.baseUrl).toBe("http://localhost:3000");
    });

    it("should populate request metadata", async () => {
      const factory = await createMeshContextFactory({
        db: database.db,

        auth: createMinimalMockAuth() as unknown as BetterAuthInstance,
        encryption: { key: "test_key" },
        observability: {
          tracer: trace.getTracer("test"),
          meter: {} as unknown as Meter,
        },
        eventBus: createMockEventBus(),
      });

      const request = createMockRequest({
        url: "https://mesh.example.com/mcp/tools",
        headers: {
          "User-Agent": "Test/1.0",
          "X-Forwarded-For": "192.168.1.1",
        },
      });

      const meshCtx = await factory(request);

      expect(meshCtx.metadata.userAgent).toBe("Test/1.0");
      expect(meshCtx.metadata.ipAddress).toBe("192.168.1.1");
      expect(meshCtx.metadata.timestamp).toBeInstanceOf(Date);
    });
  });

  describe("organization scope", () => {
    it("should extract organization from Better Auth", async () => {
      const factory = await createMeshContextFactory({
        db: database.db,

        auth: createMockAuth() as unknown as BetterAuthInstance,
        encryption: { key: "test_key" },
        observability: {
          tracer: trace.getTracer("test"),
          meter: {} as unknown as Meter,
        },
        eventBus: createMockEventBus(),
      });

      const request = createMockRequest();

      const meshCtx = await factory(request);

      expect(meshCtx.organization).toBeDefined();
      expect(meshCtx.organization?.id).toBe("org_123");
      expect(meshCtx.organization?.slug).toBe("test-org");
      expect(meshCtx.organization?.name).toBe("Test Organization");
    });

    it("should work without organization (system-level)", async () => {
      const authWithoutOrg = {
        api: {
          getMcpSession: vi.fn().mockResolvedValue(null),
          verifyApiKey: vi.fn().mockResolvedValue({
            valid: true,
            key: {
              id: "key_1",
              permissions: { self: ["COLLECTION_CONNECTIONS_LIST"] },
              metadata: {},
            },
          }),
          setActiveOrganization: vi.fn().mockResolvedValue(null),
        },
      };

      const factory = await createMeshContextFactory({
        db: database.db,

        auth: authWithoutOrg as unknown as BetterAuthInstance,
        encryption: { key: "test_key" },
        observability: {
          tracer: trace.getTracer("test"),
          meter: {} as unknown as Meter,
        },
        eventBus: createMockEventBus(),
      });

      const request = createMockRequest();
      const meshCtx = await factory(request);

      expect(meshCtx.organization).toBeUndefined();
    });
  });

  describe("storage initialization", () => {
    it("should create storage adapters", async () => {
      const factory = await createMeshContextFactory({
        db: database.db,

        auth: createMinimalMockAuth() as unknown as BetterAuthInstance,
        encryption: { key: "test_key" },
        observability: {
          tracer: trace.getTracer("test"),
          meter: {} as unknown as Meter,
        },
        eventBus: createMockEventBus(),
      });

      const request = createMockRequest({
        url: "https://mesh.example.com/mcp/tools",
        headers: {},
      });

      const meshCtx = await factory(request);

      expect(meshCtx.storage.connections).toBeDefined();
      expect(meshCtx.storage.organizationSettings).toBeDefined();
    });
  });

  describe("access control initialization", () => {
    it("should create AccessControl instance", async () => {
      const factory = await createMeshContextFactory({
        db: database.db,

        auth: createMinimalMockAuth() as unknown as BetterAuthInstance,
        encryption: { key: "test_key" },
        observability: {
          tracer: trace.getTracer("test"),
          meter: {} as unknown as Meter,
        },
        eventBus: createMockEventBus(),
      });

      const request = createMockRequest({
        url: "https://mesh.example.com/mcp/tools",
        headers: {},
      });

      const meshCtx = await factory(request);

      expect(meshCtx.access).toBeDefined();
      expect(meshCtx.access.granted).toBeDefined();
      expect(meshCtx.access.check).toBeDefined();
      expect(meshCtx.access.grant).toBeDefined();
    });
  });

  describe("API Key organization scope", () => {
    it("should set organization from API key metadata", async () => {
      const mockAuthWithOrgInApiKey = {
        api: {
          getMcpSession: vi.fn().mockResolvedValue(null),
          verifyApiKey: vi.fn().mockResolvedValue({
            valid: true,
            key: {
              id: "key_org_a",
              name: "Org A Key",
              userId: "user_1",
              permissions: { self: ["*"] },
              metadata: {
                organization: {
                  id: "org_a",
                  slug: "org-a",
                  name: "Organization A",
                },
              },
            },
          }),
          setActiveOrganization: vi.fn().mockResolvedValue(null),
        },
      };

      const factory = await createMeshContextFactory({
        db: database.db,

        auth: mockAuthWithOrgInApiKey as unknown as BetterAuthInstance,
        encryption: { key: "test_key" },
        observability: {
          tracer: trace.getTracer("test"),
          meter: {} as unknown as Meter,
        },
        eventBus: createMockEventBus(),
      });

      const request = createMockRequest({
        headers: { Authorization: "Bearer api_key_org_a" },
      });

      const meshCtx = await factory(request);

      // Organization should be extracted from API key metadata
      expect(meshCtx.organization).toBeDefined();
      expect(meshCtx.organization?.id).toBe("org_a");
      expect(meshCtx.organization?.slug).toBe("org-a");
      expect(meshCtx.organization?.name).toBe("Organization A");
    });

    it("should have undefined organization when API key has no org metadata", async () => {
      const mockAuthWithoutOrg = {
        api: {
          getMcpSession: vi.fn().mockResolvedValue(null),
          verifyApiKey: vi.fn().mockResolvedValue({
            valid: true,
            key: {
              id: "key_no_org",
              name: "No Org Key",
              userId: "user_1",
              permissions: { self: ["*"] },
              metadata: {}, // No organization
            },
          }),
        },
      };

      const factory = await createMeshContextFactory({
        db: database.db,

        auth: mockAuthWithoutOrg as unknown as BetterAuthInstance,
        encryption: { key: "test_key" },
        observability: {
          tracer: trace.getTracer("test"),
          meter: {} as unknown as Meter,
        },
        eventBus: createMockEventBus(),
      });

      const request = createMockRequest({
        headers: { Authorization: "Bearer api_key_no_org" },
      });

      const meshCtx = await factory(request);

      // Organization should be undefined when not in API key metadata
      expect(meshCtx.organization).toBeUndefined();
    });

    it("should set different organizations for different API keys", async () => {
      // Create factory for Org A key
      const mockAuthOrgA = {
        api: {
          getMcpSession: vi.fn().mockResolvedValue(null),
          verifyApiKey: vi.fn().mockResolvedValue({
            valid: true,
            key: {
              id: "key_org_a",
              userId: "user_1",
              permissions: { self: ["*"] },
              metadata: {
                organization: { id: "org_a", slug: "org-a", name: "Org A" },
              },
            },
          }),
          setActiveOrganization: vi.fn().mockResolvedValue(null),
        },
      };

      const factoryA = await createMeshContextFactory({
        db: database.db,

        auth: mockAuthOrgA as unknown as BetterAuthInstance,
        encryption: { key: "test_key" },
        observability: {
          tracer: trace.getTracer("test"),
          meter: {} as unknown as Meter,
        },
        eventBus: createMockEventBus(),
      });

      const requestA = createMockRequest({
        headers: { Authorization: "Bearer api_key_org_a" },
      });

      const ctxA = await factoryA(requestA);
      expect(ctxA.organization?.id).toBe("org_a");

      // Create factory for Org B key
      const mockAuthOrgB = {
        api: {
          getMcpSession: vi.fn().mockResolvedValue(null),
          verifyApiKey: vi.fn().mockResolvedValue({
            valid: true,
            key: {
              id: "key_org_b",
              userId: "user_1", // Same user, different org
              permissions: { self: ["*"] },
              metadata: {
                organization: { id: "org_b", slug: "org-b", name: "Org B" },
              },
            },
          }),
          setActiveOrganization: vi.fn().mockResolvedValue(null),
        },
      };

      const factoryB = await createMeshContextFactory({
        db: database.db,

        auth: mockAuthOrgB as unknown as BetterAuthInstance,
        encryption: { key: "test_key" },
        observability: {
          tracer: trace.getTracer("test"),
          meter: {} as unknown as Meter,
        },
        eventBus: createMockEventBus(),
      });

      const requestB = createMockRequest({
        headers: { Authorization: "Bearer api_key_org_b" },
      });

      const ctxB = await factoryB(requestB);
      expect(ctxB.organization?.id).toBe("org_b");

      // Verify they are different organizations
      expect(ctxA.organization?.id).not.toBe(ctxB.organization?.id);
    });
  });
});
