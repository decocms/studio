import { describe, expect, it } from "bun:test";
import {
  parseMemberRoles,
  withRoleAdded,
  withRoleRemoved,
} from "./org-role-detail";

describe("parseMemberRoles", () => {
  it("splits Better Auth's comma-joined multi-role string", () => {
    expect(parseMemberRoles("admin,billing-manager")).toEqual([
      "admin",
      "billing-manager",
    ]);
  });

  it("treats a single role and nullish values safely", () => {
    expect(parseMemberRoles("owner")).toEqual(["owner"]);
    expect(parseMemberRoles(undefined)).toEqual([]);
    expect(parseMemberRoles(null)).toEqual([]);
  });
});

describe("withRoleAdded", () => {
  it("adds the role onto an existing multi-role member without dropping the others", () => {
    expect(
      withRoleAdded(["admin", "billing-manager"], "custom-writer"),
    ).toEqual(["admin", "billing-manager", "custom-writer"]);
  });

  it("is idempotent when the member already holds the role", () => {
    expect(withRoleAdded(["admin"], "admin")).toEqual(["admin"]);
  });
});

describe("withRoleRemoved", () => {
  it("drops only the given role, keeping the member's other roles", () => {
    expect(
      withRoleRemoved(["admin", "custom-writer"], "custom-writer"),
    ).toEqual(["admin"]);
  });

  it("falls back to the default user role when no roles remain", () => {
    expect(withRoleRemoved(["custom-writer"], "custom-writer")).toEqual([
      "user",
    ]);
  });
});
