import { describe, expect, it } from "bun:test";
import { canAssignRole, validateApiKeyPermissions } from "./roles";

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
});

describe("validateApiKeyPermissions", () => {
  it("owner can grant wildcard permissions", () => {
    expect(() =>
      validateApiKeyPermissions("owner", { self: ["*"] }),
    ).not.toThrow();
  });

  it("admin can grant wildcard permissions", () => {
    expect(() =>
      validateApiKeyPermissions("admin", { self: ["*"] }),
    ).not.toThrow();
  });

  it("user cannot grant wildcard permissions", () => {
    expect(() => validateApiKeyPermissions("user", { self: ["*"] })).toThrow(
      "Insufficient privileges",
    );
  });

  it("user can grant specific tool permissions", () => {
    expect(() =>
      validateApiKeyPermissions("user", {
        self: ["COLLECTION_CONNECTIONS_LIST"],
      }),
    ).not.toThrow();
  });

  it("user cannot grant wildcard on any resource", () => {
    expect(() =>
      validateApiKeyPermissions("user", { conn_abc: ["*"] }),
    ).toThrow("Insufficient privileges");
  });

  it("undefined role cannot grant wildcard", () => {
    expect(() => validateApiKeyPermissions(undefined, { self: ["*"] })).toThrow(
      "Insufficient privileges",
    );
  });

  it("undefined permissions are allowed", () => {
    expect(() => validateApiKeyPermissions("user", undefined)).not.toThrow();
  });
});
