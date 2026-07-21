import { describe, expect, it, vi } from "bun:test";
import {
  AccessControl,
  ForbiddenError,
  UnauthorizedError,
} from "./access-control";
import type { BoundAuthClient } from "./studio-context";
import type { Permission } from "../storage/types";
import { BASIC_USAGE_TOOLS } from "../tools/registry-metadata";

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
      const ac = new AccessControl();
      ac.grant();
      expect(ac.granted()).toBe(true);
    });

    it("should allow multiple grant calls", () => {
      const ac = new AccessControl();
      ac.grant();
      ac.grant();
      expect(ac.granted()).toBe(true);
    });
  });

  describe("check", () => {
    it("should grant access when permission exists", async () => {
      const ac = new AccessControl(
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
      const mockBoundAuth = createMockBoundAuth({});
      const ac = new AccessControl("user_1", undefined, mockBoundAuth);

      ac.grant(); // Grant first

      await ac.check("ANYTHING"); // Should not check
      expect(mockBoundAuth.hasPermission).not.toHaveBeenCalled();
    });

    it("should bypass checks for admin role", async () => {
      const ac = new AccessControl(
        "user_1",
        "TEST_TOOL",
        createMockBoundAuth({}), // No permissions
        "admin", // Admin role
      );

      await ac.check();
      expect(ac.granted()).toBe(true);
    });

    it("bypasses checks for a comma-joined multi-role admin without calling boundAuth", async () => {
      // Better Auth's organization plugin joins an assigned role array with
      // "," before storing member.role, so a multi-role owner/admin (e.g.
      // "admin,billing-manager") arrives here as that comma-joined string —
      // a plain exact-match would miss it and fall through to boundAuth.
      const mockBoundAuth = createMockBoundAuth({}); // no permissions
      const ac = new AccessControl(
        "user_1",
        "TEST_TOOL",
        mockBoundAuth,
        "admin,billing-manager",
      );

      await ac.check();
      expect(ac.granted()).toBe(true);
      expect(mockBoundAuth.hasPermission).not.toHaveBeenCalled();
    });

    it("does NOT bypass the admin role for an API-key principal", async () => {
      // A key scoped to ORGANIZATION_GET is authorized solely by that allowlist —
      // the owner's admin/owner role must not widen it. The flag lives on
      // boundAuth, which enforces the key's permissions.
      const keyBoundAuth = {
        ...createMockBoundAuth({ self: ["ORGANIZATION_GET"] }),
        isApiKeyPrincipal: true,
      } as BoundAuthClient;

      const allowed = new AccessControl(
        "user_1",
        "ORGANIZATION_GET",
        keyBoundAuth,
        "admin", // owner is an admin — must NOT grant beyond the allowlist
      );
      await allowed.check();
      expect(allowed.granted()).toBe(true);

      const denied = new AccessControl(
        "user_1",
        "API_KEY_CREATE", // out of scope — the exact escalation we are blocking
        keyBoundAuth,
        "admin",
      );
      await expect(denied.check()).rejects.toThrow(ForbiddenError);
      expect(denied.granted()).toBe(false);
    });

    it("still bypasses the admin role for a non-API-key principal (session)", async () => {
      // isApiKeyPrincipal unset (browser session / MCP OAuth) → admin bypass.
      const boundAuth = {
        ...createMockBoundAuth({ self: ["ORGANIZATION_GET"] }),
        isApiKeyPrincipal: false,
      } as BoundAuthClient;

      const ac = new AccessControl(
        "user_1",
        "API_KEY_CREATE",
        boundAuth,
        "owner",
      );
      await ac.check();
      expect(ac.granted()).toBe(true);
    });

    it("should check connection-specific permissions", async () => {
      const ac = new AccessControl(
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
        "user_1",
        undefined, // No tool name
        createMockBoundAuth({}),
        "user",
      );

      await expect(ac.check()).rejects.toThrow(
        "No resources specified for access check",
      );
    });

    it("should deny access when no userId or permissions", async () => {
      const ac = new AccessControl(
        undefined, // No user
        "TEST_TOOL",
        undefined, // No boundAuth
        undefined,
      );

      await expect(ac.check()).rejects.toThrow(UnauthorizedError);
    });
  });

  // The basic-usage runtime grant lives BELOW the HTTP auth/membership
  // middleware: resolveOrgFromPath 403s non-members and mcpAuth 401s anonymous
  // callers before a tool runs. So the e2e specs (front door) can prove the
  // happy path and the routing boundary, but they can never drive checkResource
  // without an authenticated member — they can't exercise this guard at all.
  // This is the internal-logic / single-boundary-mock case TESTING.md allows,
  // and it's the only place the guard below can be regression-tested.
  describe("basic-usage grant guard", () => {
    const tool = [...BASIC_USAGE_TOOLS][0];

    it("grants a basic-usage tool to an authenticated member, regardless of role", async () => {
      const ac = new AccessControl(
        "user_1", // authenticated principal
        tool,
        createMockBoundAuth({}), // role grants nothing explicitly
        "some-custom-role", // a member (role set), not owner/admin
      );

      await ac.check();
      expect(ac.granted()).toBe(true);
    });

    it("does NOT grant basic-usage without an authenticated principal, even though boundAuth is present", async () => {
      // boundAuth is constructed for every request, so it must never be treated
      // as authentication. With no userId the grant must not fire. (Before the
      // userId guard, a role-but-no-principal state would have leaked here.)
      const ac = new AccessControl(
        undefined, // no authenticated principal
        tool,
        createMockBoundAuth({}), // boundAuth present, as it always is
        "some-custom-role", // role present, but the principal is not verified
      );

      await expect(ac.check()).rejects.toThrow(ForbiddenError);
      expect(ac.granted()).toBe(false);
    });

    it("does NOT grant basic-usage to an authenticated non-member (no role)", async () => {
      const ac = new AccessControl(
        "user_1",
        tool,
        createMockBoundAuth({}),
        undefined, // not a member of this org → no role
      );

      await expect(ac.check()).rejects.toThrow(ForbiddenError);
      expect(ac.granted()).toBe(false);
    });

    it("does NOT grant basic-usage to an API-key principal (allowlist only)", async () => {
      // An API key is a capability, not a member — it takes the api-key codepath
      // and is decided solely by its allowlist, so a basic-usage tool NOT in the
      // key's scope is denied even though the owner is an admin.
      const keyBoundAuth = {
        ...createMockBoundAuth({}), // key grants nothing
        isApiKeyPrincipal: true,
      } as BoundAuthClient;

      const ac = new AccessControl("user_1", tool, keyBoundAuth, "admin");

      await expect(ac.check()).rejects.toThrow(ForbiddenError);
      expect(ac.granted()).toBe(false);
    });
  });

  describe("granted", () => {
    it("should return false initially", () => {
      const ac = new AccessControl();
      expect(ac.granted()).toBe(false);
    });

    it("should return true after grant", () => {
      const ac = new AccessControl();
      ac.grant();
      expect(ac.granted()).toBe(true);
    });

    it("should return true after successful check", async () => {
      const ac = new AccessControl(
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

  describe("Better Auth integration", () => {
    it("should use BoundAuthClient hasPermission when available", async () => {
      const mockBoundAuth = createMockBoundAuth({ self: ["TEST_TOOL"] });

      const ac = new AccessControl(
        "user_1",
        "TEST_TOOL",
        mockBoundAuth,
        "user",
      );

      await ac.check();

      expect(mockBoundAuth.hasPermission).toHaveBeenCalledWith(
        { self: ["TEST_TOOL"] },
        // No path-resolved org (organizationId undefined). The effective-org
        // role is forwarded so boundAuth can resolve built-in roles in-memory.
        { organizationId: undefined, role: "user" },
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
        "user_1",
        "TEST_TOOL",
        undefined, // No bound auth
        "user",
      );

      await expect(ac.check()).rejects.toThrow(ForbiddenError);
    });
  });
});
