import { describe, expect, it } from "bun:test";
import { canAssignRole } from "./roles";

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
});
