import { describe, it, expect, vi } from "bun:test";
import {
  ORGANIZATION_CREATE,
  ORGANIZATION_LIST,
  ORGANIZATION_GET,
  ORGANIZATION_UPDATE,
  ORGANIZATION_DELETE,
  ORGANIZATION_MEMBER_ADD,
  ORGANIZATION_MEMBER_REMOVE,
  ORGANIZATION_MEMBER_LIST,
  ORGANIZATION_MEMBER_UPDATE_ROLE,
} from "./index";
import type {
  BetterAuthInstance,
  BoundAuthClient,
  MeshContext,
} from "../../core/mesh-context";

// Mock Better Auth instance (for legacy authInstance property)
const createMockAuth = () => ({
  api: {
    createOrganization: vi.fn().mockResolvedValue({
      id: "org_123",
      slug: "test-org",
      name: "Test Organization",
      logo: null,
      metadata: null,
      createdAt: new Date().toISOString(),
    }),
    listOrganizations: vi.fn().mockResolvedValue([
      {
        id: "org_123",
        slug: "test-org",
        name: "Test Organization",
        logo: null,
        metadata: null,
        createdAt: new Date().toISOString(),
      },
    ]),
    getFullOrganization: vi.fn().mockResolvedValue({
      id: "org_123",
      slug: "test-org",
      name: "Test Organization",
      logo: null,
      metadata: null,
      createdAt: new Date().toISOString(),
    }),
    updateOrganization: vi.fn().mockResolvedValue({
      id: "org_123",
      slug: "updated-org",
      name: "Updated Organization",
      logo: null,
      metadata: null,
      createdAt: new Date().toISOString(),
    }),
    deleteOrganization: vi.fn().mockResolvedValue(undefined),
    addMember: vi.fn().mockResolvedValue({
      id: "member_123",
      organizationId: "org_123",
      userId: "user_456",
      role: ["member"],
      createdAt: new Date().toISOString(),
    }),
    removeMember: vi.fn().mockResolvedValue(undefined),
    listMembers: vi.fn().mockResolvedValue([
      {
        id: "member_123",
        organizationId: "org_123",
        userId: "user_1",
        role: ["admin"],
        createdAt: new Date().toISOString(),
        user: {
          id: "user_1",
          name: "Test User",
          email: "[email protected]",
        },
      },
    ]),
    updateMemberRole: vi.fn().mockResolvedValue({
      id: "member_123",
      organizationId: "org_123",
      userId: "user_456",
      role: ["admin"],
    }),
  },
});

// Mock BoundAuthClient that wraps the mock auth
const createMockBoundAuth = (
  mockAuth: ReturnType<typeof createMockAuth>,
): BoundAuthClient => ({
  hasPermission: vi.fn().mockResolvedValue(true),
  organization: {
    create: vi.fn(async (data) => {
      return mockAuth.api.createOrganization({
        body: data,
      });
    }),
    update: vi.fn(async (data) => {
      return mockAuth.api.updateOrganization({
        body: data,
        headers: new Headers(),
      });
    }),
    delete: vi.fn(async (organizationId) => {
      return mockAuth.api.deleteOrganization({
        body: { organizationId },
        headers: new Headers(),
      });
    }),
    get: vi.fn(async () => {
      return mockAuth.api.getFullOrganization();
    }),
    list: vi.fn(async (userId) => {
      return mockAuth.api.listOrganizations({
        query: { userId },
      });
    }),
    addMember: vi.fn(async (data) => {
      return mockAuth.api.addMember({
        body: data,
      });
    }),
    removeMember: vi.fn(async (data) => {
      return mockAuth.api.removeMember({
        body: data,
      });
    }),
    listMembers: vi.fn(async (options) => {
      return mockAuth.api.listMembers({
        query: options,
      });
    }),
    updateMemberRole: vi.fn(async (data) => {
      return mockAuth.api.updateMemberRole({
        body: data,
      });
    }),
  },
  apiKey: {
    create: vi.fn().mockResolvedValue({
      id: "key_123",
      name: "Test Key",
      key: "mcp_test_key_123",
      permissions: {},
      expiresAt: null,
      createdAt: new Date(),
    }),
    list: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({
      id: "key_123",
      name: "Updated Key",
      userId: "user_1",
      permissions: {},
      expiresAt: null,
      createdAt: new Date(),
    }),
    delete: vi.fn().mockResolvedValue(undefined),
  },
});

const createMockContext = (
  authInstance: ReturnType<typeof createMockAuth> = createMockAuth(),
): MeshContext => {
  const boundAuth = createMockBoundAuth(authInstance);
  return {
    timings: {
      measure: async <T>(_name: string, cb: () => Promise<T>) => await cb(),
    },
    eventBus: vi.fn().mockResolvedValue(undefined) as never,
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
      connections: null as never,
      organizationSettings: {
        get: vi.fn(),
        upsert: vi.fn(),
      } as never,
      monitoring: null as never,
      virtualMcps: null as never,
      users: null as never,
      threads: null as never,
      tags: null as never,
      projects: null as never,
      projectPluginConfigs: null as never,
      monitoringDashboards: null as never,
    },
    vault: null as never,
    authInstance: authInstance as unknown as BetterAuthInstance,
    boundAuth,
    access: {
      granted: () => true,
      check: vi.fn().mockResolvedValue(undefined),
      grant: () => {},
      setToolName: () => {},
    } as never,
    db: null as never,
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
    createMCPProxy: vi.fn().mockResolvedValue({}),
    getOrCreateClient: vi.fn().mockResolvedValue({}),
  };
};

describe("Organization Tools", () => {
  describe("ORGANIZATION_CREATE", () => {
    it("should create a new organization", async () => {
      const mockAuth = createMockAuth();
      const ctx = createMockContext(mockAuth);

      const result = await ORGANIZATION_CREATE.execute(
        {
          name: "Test Organization",
          slug: "test-org",
          description: "Test description",
        },
        ctx,
      );

      expect(mockAuth.api.createOrganization).toHaveBeenCalledWith({
        body: expect.objectContaining({
          name: "Test Organization",
          slug: "test-org",
          metadata: { description: "Test description" },
          userId: "user_1",
        }),
      });

      expect(result.id).toBe("org_123");
      expect(result.slug).toBe("test-org");
      expect(result.name).toBe("Test Organization");
    });

    it("should require authentication", async () => {
      const ctx = createMockContext();
      ctx.auth.user = undefined;

      await expect(
        ORGANIZATION_CREATE.execute(
          {
            name: "Test",
            slug: "test",
          },
          ctx,
        ),
      ).rejects.toThrow("Authentication required");
    });

    // Note: Slug validation is handled by Zod/MCP protocol layer in production
    // When calling execute() directly in tests, we bypass MCP validation
  });

  describe("ORGANIZATION_LIST", () => {
    it("should list organizations for current user", async () => {
      const mockAuth = createMockAuth();
      const ctx = createMockContext(mockAuth);

      const result = await ORGANIZATION_LIST.execute({}, ctx);

      expect(mockAuth.api.listOrganizations).toHaveBeenCalledWith({
        query: { userId: "user_1" },
      });

      expect(result.organizations).toHaveLength(1);
      expect(result.organizations?.[0]?.slug).toBe("test-org");
    });

    it("should list organizations for specific user", async () => {
      const mockAuth = createMockAuth();
      const ctx = createMockContext(mockAuth);

      await ORGANIZATION_LIST.execute(
        {
          userId: "user_2",
        },
        ctx,
      );

      expect(mockAuth.api.listOrganizations).toHaveBeenCalledWith({
        query: { userId: "user_2" },
      });
    });
  });

  describe("ORGANIZATION_GET", () => {
    it("should get active organization", async () => {
      const mockAuth = createMockAuth();
      const ctx = createMockContext(mockAuth);

      const result = await ORGANIZATION_GET.execute({}, ctx);

      expect(mockAuth.api.getFullOrganization).toHaveBeenCalled();
      expect(result.id).toBe("org_123");
      expect(result.slug).toBe("test-org");
    });

    it("should throw when no active organization", async () => {
      const mockAuth = createMockAuth();
      mockAuth.api.getFullOrganization.mockResolvedValue(null);
      const ctx = createMockContext(mockAuth);

      await expect(ORGANIZATION_GET.execute({}, ctx)).rejects.toThrow(
        "No active organization found",
      );
    });
  });

  describe("ORGANIZATION_UPDATE", () => {
    it("should update organization", async () => {
      const mockAuth = createMockAuth();
      const ctx = createMockContext(mockAuth);

      const result = await ORGANIZATION_UPDATE.execute(
        {
          id: "org_123",
          name: "Updated Name",
          slug: "updated-slug",
        },
        ctx,
      );

      expect(mockAuth.api.updateOrganization).toHaveBeenCalledWith({
        body: {
          organizationId: "org_123",
          data: expect.objectContaining({
            name: "Updated Name",
            slug: "updated-slug",
          }),
        },
        headers: expect.any(Headers),
      });

      expect(result.slug).toBe("updated-org");
    });
  });

  describe("ORGANIZATION_DELETE", () => {
    it("should delete organization", async () => {
      const mockAuth = createMockAuth();
      const ctx = createMockContext(mockAuth);

      const result = await ORGANIZATION_DELETE.execute(
        {
          id: "org_123",
        },
        ctx,
      );

      expect(mockAuth.api.deleteOrganization).toHaveBeenCalledWith({
        body: { organizationId: "org_123" },
        headers: expect.any(Headers),
      });

      expect(result.success).toBe(true);
      expect(result.id).toBe("org_123");
    });
  });

  describe("ORGANIZATION_MEMBER_ADD", () => {
    it("should add a member to organization", async () => {
      const mockAuth = createMockAuth();
      const ctx = createMockContext(mockAuth);

      const result = await ORGANIZATION_MEMBER_ADD.execute(
        {
          userId: "user_456",
          role: ["user"],
        },
        ctx,
      );

      expect(mockAuth.api.addMember).toHaveBeenCalledWith({
        body: {
          organizationId: "org_123",
          userId: "user_456",
          role: ["user"],
        },
      });

      expect(result.id).toBe("member_123");
      expect(result.userId).toBe("user_456");
      expect(result.role).toEqual(["member"]);
    });

    it("should use active organization from context", async () => {
      const mockAuth = createMockAuth();
      const ctx = createMockContext(mockAuth);

      await ORGANIZATION_MEMBER_ADD.execute(
        {
          userId: "user_456",
          role: ["user"],
        },
        ctx,
      );

      expect(mockAuth.api.addMember).toHaveBeenCalledWith({
        body: expect.objectContaining({
          organizationId: "org_123",
        }),
      });
    });

    it("should allow explicit organizationId matching context", async () => {
      const mockAuth = createMockAuth();
      const ctx = createMockContext(mockAuth);

      await ORGANIZATION_MEMBER_ADD.execute(
        {
          organizationId: "org_123",
          userId: "user_456",
          role: ["user"],
        },
        ctx,
      );

      expect(mockAuth.api.addMember).toHaveBeenCalledWith({
        body: expect.objectContaining({
          organizationId: "org_123",
        }),
      });
    });

    it("should reject organizationId that does not match context", async () => {
      const mockAuth = createMockAuth();
      const ctx = createMockContext(mockAuth);

      await expect(
        ORGANIZATION_MEMBER_ADD.execute(
          {
            organizationId: "org_456",
            userId: "user_456",
            role: ["user"],
          },
          ctx,
        ),
      ).rejects.toThrow(
        "Organization ID does not match authenticated organization",
      );

      expect(mockAuth.api.addMember).not.toHaveBeenCalled();
    });
  });

  describe("ORGANIZATION_MEMBER_REMOVE", () => {
    it("should remove a member from organization", async () => {
      const mockAuth = createMockAuth();
      const ctx = createMockContext(mockAuth);

      const result = await ORGANIZATION_MEMBER_REMOVE.execute(
        {
          memberIdOrEmail: "[email protected]",
        },
        ctx,
      );

      expect(mockAuth.api.removeMember).toHaveBeenCalledWith({
        body: {
          organizationId: "org_123",
          memberIdOrEmail: "[email protected]",
        },
      });

      expect(result.success).toBe(true);
      expect(result.memberIdOrEmail).toBe("[email protected]");
    });
  });

  describe("ORGANIZATION_MEMBER_LIST", () => {
    it("should list all members in organization", async () => {
      const mockAuth = createMockAuth();
      const ctx = createMockContext(mockAuth);

      const result = await ORGANIZATION_MEMBER_LIST.execute({}, ctx);

      expect(mockAuth.api.listMembers).toHaveBeenCalledWith({
        query: {
          organizationId: "org_123",
          limit: undefined,
          offset: undefined,
        },
      });

      expect(result.members).toHaveLength(1);
      expect(result.members?.[0]?.userId).toBe("user_1");
      expect(result.members?.[0]?.role as unknown as string[]).toEqual([
        "admin",
      ]);
    });

    it("should support pagination", async () => {
      const mockAuth = createMockAuth();
      const ctx = createMockContext(mockAuth);

      await ORGANIZATION_MEMBER_LIST.execute(
        {
          limit: 10,
          offset: 5,
        },
        ctx,
      );

      expect(mockAuth.api.listMembers).toHaveBeenCalledWith({
        query: {
          organizationId: "org_123",
          limit: 10,
          offset: 5,
        },
      });
    });
  });

  describe("ORGANIZATION_MEMBER_UPDATE_ROLE", () => {
    it("should update member role", async () => {
      const mockAuth = createMockAuth();
      const ctx = createMockContext(mockAuth);

      const result = await ORGANIZATION_MEMBER_UPDATE_ROLE.execute(
        {
          memberId: "member_123",
          role: ["admin"],
        },
        ctx,
      );

      expect(mockAuth.api.updateMemberRole).toHaveBeenCalledWith({
        body: {
          organizationId: "org_123",
          memberId: "member_123",
          role: ["admin"],
        },
      });

      expect(result.role as unknown as string[]).toEqual(["admin"]);
    });
  });
});
