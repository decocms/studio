import { describe, expect, it, vi } from "bun:test";
import {
  AccessControl,
  ForbiddenError,
  UnauthorizedError,
} from "./access-control";
import type { BetterAuthInstance, BoundAuthClient } from "./mesh-context";
import type { Permission } from "../storage/types";

const createMockAuth = (): BetterAuthInstance => {
  const mockUserHasPermission = vi.fn();
  return {
    api: {
      userHasPermission: mockUserHasPermission,
    },
    handler: vi.fn().mockResolvedValue(new Response()),
  } as unknown as BetterAuthInstance;
};

/**
 * Create a mock BoundAuthClient that checks permissions against a given Permission object
 */
const createMockBoundAuth = (permissions: Permission): BoundAuthClient => {
  return {
    hasPermission: vi.fn(async (requestedPermission: Permission) => {
      // Check if any of the requested permissions match
      for (const [connectionId, tools] of Object.entries(requestedPermission)) {
        const allowedTools = permissions[connectionId];
        if (!allowedTools) continue;

        // Check if any requested tool is allowed
        for (const tool of tools as string[]) {
          if (allowedTools.includes(tool) || allowedTools.includes("*")) {
            return true;
          }
        }
      }
      return false;
    }),
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
  } as unknown as BoundAuthClient;
};

describe("AccessControl", () => {
  describe("grant", () => {
    it("should grant access unconditionally", () => {
      const ac = new AccessControl(createMockAuth());
      ac.grant();
      expect(ac.granted()).toBe(true);
    });

    it("should allow multiple grant calls", () => {
      const ac = new AccessControl(createMockAuth());
      ac.grant();
      ac.grant();
      expect(ac.granted()).toBe(true);
    });
  });

  describe("check", () => {
    it("should grant access when permission exists", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        "TEST_TOOL",
        createMockBoundAuth({ self: ["TEST_TOOL"] }), // Has permission on self connection
        "user",
      );

      await ac.check();
      expect(ac.granted()).toBe(true);
    });

    it("should deny access when permission missing", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        "TEST_TOOL",
        createMockBoundAuth({ self: ["OTHER_TOOL"] }), // Has OTHER_TOOL but not TEST_TOOL
        "user",
      );

      await expect(ac.check()).rejects.toThrow(ForbiddenError);
      expect(ac.granted()).toBe(false);
    });

    it("should check current tool name by default", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        "MY_TOOL",
        createMockBoundAuth({ self: ["MY_TOOL"] }), // Permission on self connection
        "user",
      );

      await ac.check();
      expect(ac.granted()).toBe(true);
    });

    it("should check specific resources when provided", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        undefined,
        createMockBoundAuth({ conn_123: ["SEND_MESSAGE"] }),
        "user",
        "conn_123", // Checking conn_123
      );

      await ac.check("SEND_MESSAGE");
      expect(ac.granted()).toBe(true);
    });

    it("should use OR logic for multiple resources", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        undefined,
        createMockBoundAuth({ self: ["TOOL2"] }), // Has TOOL2 on self connection
        "user",
      );

      // Has TOOL2 but not TOOL1 - should succeed (OR logic)
      await ac.check("TOOL1", "TOOL2");
      expect(ac.granted()).toBe(true);
    });

    it("should skip check if already granted", async () => {
      const mockAuth = createMockAuth();
      const mockBoundAuth = createMockBoundAuth({});
      const ac = new AccessControl(
        mockAuth,
        "user_1",
        undefined,
        mockBoundAuth,
      );

      ac.grant(); // Grant first

      await ac.check("ANYTHING"); // Should not check
      expect(mockBoundAuth.hasPermission).not.toHaveBeenCalled();
    });

    it("should bypass checks for admin role", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        "TEST_TOOL",
        createMockBoundAuth({}), // No permissions
        "admin", // Admin role
      );

      await ac.check();
      expect(ac.granted()).toBe(true);
    });

    it("should check connection-specific permissions", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        "SEND_MESSAGE",
        createMockBoundAuth({ conn_123: ["SEND_MESSAGE"] }),
        "user",
        "conn_123", // Connection ID
      );

      await ac.check("SEND_MESSAGE");
      expect(ac.granted()).toBe(true);
    });

    it("should throw when no resources specified", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        undefined, // No tool name
        createMockBoundAuth({}),
        "user",
      );

      await expect(ac.check()).rejects.toThrow(
        "No resources specified for access check",
      );
    });

    it("should work with wildcard permissions", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        undefined,
        createMockBoundAuth({ conn_123: ["*"] }), // Wildcard
        "user",
        "conn_123", // Checking conn_123
      );

      await ac.check("SOME_TOOL");
      expect(ac.granted()).toBe(true);
    });

    it("should deny access when no userId or permissions", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        undefined, // No user
        "TEST_TOOL",
        undefined, // No boundAuth
        undefined,
      );

      await expect(ac.check()).rejects.toThrow(UnauthorizedError);
    });
  });

  describe("granted", () => {
    it("should return false initially", () => {
      const ac = new AccessControl(createMockAuth());
      expect(ac.granted()).toBe(false);
    });

    it("should return true after grant", () => {
      const ac = new AccessControl(createMockAuth());
      ac.grant();
      expect(ac.granted()).toBe(true);
    });

    it("should return true after successful check", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        "TEST_TOOL",
        createMockBoundAuth({ self: ["TEST_TOOL"] }), // Permission on self connection
        "user",
      );

      await ac.check();
      expect(ac.granted()).toBe(true);
    });

    it("should return false after failed check", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        "TEST_TOOL",
        createMockBoundAuth({}), // No permissions
        "user", // Not admin
      );

      try {
        await ac.check();
      } catch {
        // Expected to throw
      }

      expect(ac.granted()).toBe(false);
    });
  });

  describe("manual permission check", () => {
    it("should match exact resource name", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        undefined,
        createMockBoundAuth({ self: ["EXACT_MATCH"] }), // Permission on self connection
        "user",
      );

      await ac.check("EXACT_MATCH");
      expect(ac.granted()).toBe(true);
    });

    it("should match resource in actions array", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        undefined,
        createMockBoundAuth({ conn_123: ["SEND_MESSAGE", "LIST_THREADS"] }),
        "user",
        "conn_123", // Checking conn_123
      );

      await ac.check("SEND_MESSAGE");
      expect(ac.granted()).toBe(true);
    });

    it("should respect connection ID filter", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        undefined,
        createMockBoundAuth({
          conn_123: ["SEND_MESSAGE"],
          conn_456: ["SEND_MESSAGE"],
        }),
        "user",
        "conn_123", // Only check this connection
      );

      await ac.check("SEND_MESSAGE");
      expect(ac.granted()).toBe(true);
    });

    it("should deny when connection ID does not match", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        undefined,
        createMockBoundAuth({
          conn_456: ["SEND_MESSAGE"], // Different connection
        }),
        "user",
        "conn_123", // Checking this connection
      );

      await expect(ac.check("SEND_MESSAGE")).rejects.toThrow(ForbiddenError);
    });
  });

  describe("Better Auth integration", () => {
    it("should use BoundAuthClient hasPermission when available", async () => {
      const mockBoundAuth = createMockBoundAuth({ self: ["TEST_TOOL"] });

      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        "TEST_TOOL",
        mockBoundAuth,
        "user",
      );

      await ac.check();

      expect(mockBoundAuth.hasPermission).toHaveBeenCalledWith(
        { self: ["TEST_TOOL"] },
        undefined, // No path-resolved org passed, so options is undefined
      );
      expect(ac.granted()).toBe(true);
    });

    it("should deny access when hasPermission returns false", async () => {
      // Create a mock that always returns false
      const mockBoundAuth: BoundAuthClient = {
        hasPermission: vi.fn().mockResolvedValue(false),
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
      } as unknown as BoundAuthClient;

      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        "TEST_TOOL",
        mockBoundAuth,
        "user",
      );

      await expect(ac.check()).rejects.toThrow(ForbiddenError);
      expect(ac.granted()).toBe(false);
    });

    it("should deny access when no BoundAuthClient provided", async () => {
      const ac = new AccessControl(
        createMockAuth(),
        "user_1",
        "TEST_TOOL",
        undefined, // No bound auth
        "user",
      );

      await expect(ac.check()).rejects.toThrow(ForbiddenError);
    });
  });
});
