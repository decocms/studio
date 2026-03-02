import { describe, expect, it } from "bun:test";
import {
  type MeshContext,
  getOrganizationId,
  getUserId,
  hasOrganization,
  isAuthenticated,
  requireAuth,
  requireOrganization,
} from "./mesh-context";
import type { EventBus } from "../event-bus/interface";

// Helper to create mock context
const createMockContext = (overrides?: Partial<MeshContext>): MeshContext => ({
  timings: {
    measure: async <T>(_name: string, cb: () => Promise<T>) => await cb(),
  },
  auth: {},
  storage: {
    connections: null as never,
    organizationSettings: null as never,
    monitoring: null as never,
    virtualMcps: null as never,
    users: null as never,
    threads: null as never,
    tags: null as never,
    projects: null as never,
    projectPluginConfigs: null as never,
    monitoringDashboards: null as never,
    triggers: null as never,
  },
  vault: null as never,
  authInstance: null as never,
  boundAuth: {
    hasPermission: async () => false,
    organization: {
      create: async () => ({ data: null, error: null }),
      update: async () => ({ data: null, error: null }),
      delete: async () => {},
      get: async () => ({ data: null, error: null }),
      list: async () => ({ data: [], error: null }),
      addMember: async () => ({ data: null, error: null }),
      removeMember: async () => {},
      listMembers: async () => ({ data: [], error: null }),
      updateMemberRole: async () => ({ data: null, error: null }),
    },
  } as never,
  access: null as never,
  db: null as never,
  tracer: null as never,
  meter: null as never,
  baseUrl: "https://mesh.example.com",
  metadata: {
    requestId: "req_123",
    timestamp: new Date(),
  },
  eventBus: null as unknown as EventBus,
  createMCPProxy: async () => ({}) as never,
  getOrCreateClient: async () => ({}) as never,
  ...overrides,
});

describe("MeshContext Utilities", () => {
  describe("hasOrganization", () => {
    it("should return true when organization is defined", () => {
      const ctx = createMockContext({
        organization: { id: "org_1", slug: "test-org", name: "Test Org" },
      });
      expect(hasOrganization(ctx)).toBe(true);
    });

    it("should return false when organization is undefined", () => {
      const ctx = createMockContext();
      expect(hasOrganization(ctx)).toBe(false);
    });
  });

  describe("getOrganizationId", () => {
    it("should return organization ID when defined", () => {
      const ctx = createMockContext({
        organization: { id: "org_1", slug: "test-org", name: "Test Org" },
      });
      expect(getOrganizationId(ctx)).toBe("org_1");
    });

    it("should return null when organization is undefined", () => {
      const ctx = createMockContext();
      expect(getOrganizationId(ctx)).toBeNull();
    });
  });

  describe("requireOrganization", () => {
    it("should return organization when defined", () => {
      const organization = { id: "org_1", slug: "test-org", name: "Test Org" };
      const ctx = createMockContext({ organization });
      expect(requireOrganization(ctx)).toEqual(organization);
    });

    it("should throw when organization is undefined", () => {
      const ctx = createMockContext();
      expect(() => requireOrganization(ctx)).toThrow(
        "This operation requires organization scope",
      );
    });
  });

  describe("getUserId", () => {
    it("should return user ID when user is authenticated", () => {
      const ctx = createMockContext({
        auth: {
          user: {
            id: "user_1",
            email: "[email protected]",
            name: "Test",
            role: "user",
          },
        },
      });
      expect(getUserId(ctx)).toBe("user_1");
    });

    it("should return API key userId when API key is used", () => {
      const ctx = createMockContext({
        auth: {
          apiKey: {
            id: "key_1",
            name: "Test Key",
            userId: "user_2",
          },
        },
      });
      expect(getUserId(ctx)).toBe("user_2");
    });

    it("should prefer user ID over API key userId", () => {
      const ctx = createMockContext({
        auth: {
          user: {
            id: "user_1",
            email: "[email protected]",
            name: "Test",
            role: "user",
          },
          apiKey: {
            id: "key_1",
            name: "Test Key",
            userId: "user_2",
          },
        },
      });
      expect(getUserId(ctx)).toBe("user_1");
    });

    it("should return undefined when not authenticated", () => {
      const ctx = createMockContext();
      expect(getUserId(ctx)).toBeUndefined();
    });
  });

  describe("isAuthenticated", () => {
    it("should return true when user is authenticated", () => {
      const ctx = createMockContext({
        auth: {
          user: {
            id: "user_1",
            email: "[email protected]",
            name: "Test",
            role: "user",
          },
        },
      });
      expect(isAuthenticated(ctx)).toBe(true);
    });

    it("should return true when API key is used", () => {
      const ctx = createMockContext({
        auth: {
          apiKey: {
            id: "key_1",
            name: "Test",
            userId: "user_1",
          },
        },
      });
      expect(isAuthenticated(ctx)).toBe(true);
    });

    it("should return false when not authenticated", () => {
      const ctx = createMockContext();
      expect(isAuthenticated(ctx)).toBe(false);
    });
  });

  describe("requireAuth", () => {
    it("should not throw when authenticated with user", () => {
      const ctx = createMockContext({
        auth: {
          user: {
            id: "user_1",
            email: "[email protected]",
            name: "Test",
            role: "user",
          },
        },
      });
      expect(() => requireAuth(ctx)).not.toThrow();
    });

    it("should not throw when authenticated with API key", () => {
      const ctx = createMockContext({
        auth: {
          apiKey: {
            id: "key_1",
            name: "Test",
            userId: "user_1",
          },
        },
      });
      expect(() => requireAuth(ctx)).not.toThrow();
    });

    it("should throw when not authenticated", () => {
      const ctx = createMockContext();
      expect(() => requireAuth(ctx)).toThrow("Authentication required");
    });
  });
});
