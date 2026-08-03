import { describe, expect, test } from "bun:test";
import {
  ThreadAuthorityError,
  resolveThreadAuthority,
} from "./thread-authority";

const thread = {
  organization_id: "org-1",
  created_by: "user-1",
  virtual_mcp_id: "agent-canonical",
};

describe("resolveThreadAuthority", () => {
  test("derives the executing agent from the persisted thread", () => {
    expect(
      resolveThreadAuthority(thread, {
        organizationId: "org-1",
        userId: "user-1",
      }),
    ).toEqual({ agentId: "agent-canonical" });
  });

  test("checks ownership before agent resolution", () => {
    try {
      resolveThreadAuthority(thread, {
        organizationId: "org-1",
        userId: "another-user",
      });
      throw new Error("Expected thread authority to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThreadAuthorityError);
      expect((error as ThreadAuthorityError).reason).toBe("owner_mismatch");
    }
  });

  test("rejects a thread from another organization", () => {
    expect(() =>
      resolveThreadAuthority(thread, {
        organizationId: "org-2",
        userId: "user-1",
      }),
    ).toThrow("Thread does not belong to this organization");
  });

  test("rejects empty and whitespace-only persisted agent ids", () => {
    for (const virtual_mcp_id of ["", "   "]) {
      expect(() =>
        resolveThreadAuthority(
          { ...thread, virtual_mcp_id },
          { organizationId: "org-1", userId: "user-1" },
        ),
      ).toThrow("Thread has no assigned agent");
    }
  });
});
