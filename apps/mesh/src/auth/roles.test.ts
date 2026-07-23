import { describe, expect, it } from "bun:test";
import { canAssignRole, hasAdminRole } from "./roles";

describe("canAssignRole", () => {
  it("owner can assign any role", () => {
    expect(canAssignRole("owner", "owner")).toBe(true);
    expect(canAssignRole("owner", "admin")).toBe(true);
    expect(canAssignRole("owner", "user")).toBe(true);
    expect(canAssignRole("owner", "custom-role")).toBe(true);
  });

  it("admin can assign non-owner roles", () => {
    expect(canAssignRole("admin", "admin")).toBe(true);
    expect(canAssignRole("admin", "user")).toBe(true);
    expect(canAssignRole("admin", "custom-role")).toBe(true);
  });

  it("admin cannot assign owner role", () => {
    expect(canAssignRole("admin", "owner")).toBe(false);
  });

  it("user role cannot assign any role", () => {
    expect(canAssignRole("user", "user")).toBe(false);
    expect(canAssignRole("user", "admin")).toBe(false);
    expect(canAssignRole("user", "owner")).toBe(false);
  });

  it("undefined caller role cannot assign any role", () => {
    expect(canAssignRole(undefined, "user")).toBe(false);
    expect(canAssignRole(undefined, "owner")).toBe(false);
  });

  // Regression for #3388: a member's caller role is the org plugin's
  // default "member" string, not the built-in "user" role. canAssignRole
  // must deny it just like any other non-admin/owner role — a member must
  // not be able to self-promote to admin by calling
  // ORGANIZATION_MEMBER_UPDATE_ROLE against their own member row.
  it("plain member role cannot self-promote to admin or owner", () => {
    expect(canAssignRole("member", "admin")).toBe(false);
    expect(canAssignRole("member", "owner")).toBe(false);
    expect(canAssignRole("member", "member")).toBe(false);
  });

  // Better Auth's organization plugin supports multi-role members, and
  // callers forward the whole role array to it. An admin must not be able
  // to smuggle "owner" in alongside an allowed role by relying on a caller
  // that only validates the first array entry.
  it("admin cannot assign owner by hiding it in a multi-role array", () => {
    expect(canAssignRole("admin", ["user", "owner"])).toBe(false);
    expect(canAssignRole("admin", ["owner", "user"])).toBe(false);
    expect(canAssignRole("admin", ["user", "admin"])).toBe(true);
  });

  it("owner can assign a multi-role array, empty array is denied", () => {
    expect(canAssignRole("owner", ["admin", "owner"])).toBe(true);
    expect(canAssignRole("admin", [])).toBe(false);
    expect(canAssignRole("owner", [])).toBe(false);
  });

  // Better Auth's `parseRoles` joins an assigned role array with "," before
  // storing `member.role`, so a multi-role owner/admin's OWN role — the
  // `callerRole` here — can arrive as that same comma-joined string, not just
  // as a lone "owner"/"admin". A caller check that only does `=== "owner"`
  // would wrongly deny a legitimate multi-role owner/admin.
  it("recognizes a multi-role caller from a comma-joined callerRole", () => {
    expect(canAssignRole("owner,billing-manager", "admin")).toBe(true);
    expect(canAssignRole("admin,billing-manager", "user")).toBe(true);
    expect(canAssignRole("admin,billing-manager", "owner")).toBe(false);
    expect(canAssignRole("billing-manager,user", "admin")).toBe(false);
  });
});

describe("hasAdminRole", () => {
  it("recognizes a plain admin/owner role", () => {
    expect(hasAdminRole("owner")).toBe(true);
    expect(hasAdminRole("admin")).toBe(true);
  });

  it("denies non-admin roles", () => {
    expect(hasAdminRole("user")).toBe(false);
    expect(hasAdminRole("member")).toBe(false);
    expect(hasAdminRole(undefined)).toBe(false);
  });

  // Same comma-joined multi-role string canAssignRole's callerRole handles —
  // an exact-match check must not deny a legitimate multi-role owner/admin.
  it("recognizes an admin/owner role inside a comma-joined multi-role string", () => {
    expect(hasAdminRole("admin,billing-manager")).toBe(true);
    expect(hasAdminRole("billing-manager,owner")).toBe(true);
    expect(hasAdminRole("billing-manager,user")).toBe(false);
  });
});
