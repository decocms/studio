/**
 * Pure-logic unit tests for the in-memory built-in-role permission matcher.
 *
 * No mocks, no DB, no network (TESTING.md "Unit" tier). These assert the
 * matcher's logic in isolation; end-to-end PARITY with the live Better Auth
 * path is covered by the e2e spec (member-permission-parity.spec.ts) and was
 * additionally verified offline against the real `authorize()` (1056 probes,
 * zero mismatches — see PR description / parity argument).
 */

import { describe, expect, it } from "bun:test";
import {
  getBuiltinRoleStatements,
  matchStatement,
  resolveBuiltinRolePermission,
} from "./builtin-role-permission";
import type { Permission } from "@/storage/types";

// A representative built-in statement map. `user` has a literal `self` tool
// list (no "*"); `admin`/`owner` carry "*" plus enumerated tools. Mirrors the
// real shape so the matcher is exercised the way Flow 2 uses it.
const STATEMENTS: Record<string, Permission> = {
  user: {
    self: ["TOOL_A", "TOOL_B"],
    organization: [],
    member: [],
    ac: ["read"],
  },
  admin: { self: ["*", "TOOL_A", "TOOL_B"], organization: ["update"] },
  owner: { self: ["*", "TOOL_A", "TOOL_B"], organization: ["update"] },
};

describe("matchStatement", () => {
  it("grants when the resource key lists the exact action", () => {
    expect(matchStatement({ self: ["TOOL_A"] }, { self: ["TOOL_A"] })).toBe(
      true,
    );
  });

  it("denies when the action is absent and no wildcard is present", () => {
    expect(matchStatement({ self: ["TOOL_A"] }, { self: ["TOOL_B"] })).toBe(
      false,
    );
  });

  it("grants via a '*' wildcard action in the statement", () => {
    expect(matchStatement({ self: ["*"] }, { self: ["ANYTHING"] })).toBe(true);
  });

  it("denies when the requested resource key is missing from the statement", () => {
    // Mirrors Better Auth: `if (!allowedActions) return {success:false}`.
    expect(matchStatement({ self: ["TOOL_A"] }, { conn_x: ["TOOL_A"] })).toBe(
      false,
    );
  });

  it("requires EVERY requested action to be granted (AND within a resource)", () => {
    expect(
      matchStatement({ self: ["TOOL_A", "TOOL_B"] }, { self: ["TOOL_A"] }),
    ).toBe(true);
    expect(
      matchStatement(
        { self: ["TOOL_A"] },
        { self: ["TOOL_A", "TOOL_MISSING"] },
      ),
    ).toBe(false);
  });

  it("requires EVERY requested resource to be granted (AND across resources)", () => {
    const stmt = { self: ["TOOL_A"], member: ["read"] };
    expect(matchStatement(stmt, { self: ["TOOL_A"], member: ["read"] })).toBe(
      true,
    );
    expect(matchStatement(stmt, { self: ["TOOL_A"], member: ["write"] })).toBe(
      false,
    );
  });
});

describe("resolveBuiltinRolePermission", () => {
  it("grants a built-in user role for a tool in its self list", () => {
    expect(
      resolveBuiltinRolePermission("user", { self: ["TOOL_A"] }, STATEMENTS),
    ).toBe("grant");
  });

  it("denies a built-in user role for a tool NOT in its self list", () => {
    expect(
      resolveBuiltinRolePermission(
        "user",
        { self: ["TOOL_MISSING"] },
        STATEMENTS,
      ),
    ).toBe("deny");
  });

  it("denies a user role for connection-scoped resources (no conn_ key)", () => {
    // A pure built-in `user` browser session has no connection grants; Better
    // Auth's static `user` statement likewise has no conn_ key → deny.
    expect(
      resolveBuiltinRolePermission(
        "user",
        { conn_abc: ["SEND_MESSAGE"] },
        STATEMENTS,
      ),
    ).toBe("deny");
  });

  it("grants an admin/owner role via the self '*' wildcard", () => {
    expect(
      resolveBuiltinRolePermission("admin", { self: ["ANY_TOOL"] }, STATEMENTS),
    ).toBe("grant");
    expect(
      resolveBuiltinRolePermission("owner", { self: ["ANY_TOOL"] }, STATEMENTS),
    ).toBe("grant");
  });

  it("resolves multi-resource requests (all must pass)", () => {
    expect(
      resolveBuiltinRolePermission(
        "user",
        { self: ["TOOL_A"], member: [] },
        STATEMENTS,
      ),
    ).toBe("grant");
    expect(
      resolveBuiltinRolePermission(
        "user",
        { self: ["TOOL_A", "TOOL_MISSING"] },
        STATEMENTS,
      ),
    ).toBe("deny");
  });

  // ---- Fall-back decisions: caller must use the Better Auth path ----

  it("falls back for an undefined role", () => {
    expect(
      resolveBuiltinRolePermission(undefined, { self: ["TOOL_A"] }, STATEMENTS),
    ).toBe("fallback");
  });

  it("falls back for a custom (non-built-in) role name", () => {
    expect(
      resolveBuiltinRolePermission(
        "billing-manager",
        { self: ["TOOL_A"] },
        STATEMENTS,
      ),
    ).toBe("fallback");
  });

  it("falls back for comma-joined multi-role strings (never partially resolve)", () => {
    // The OR-over-roles may include a custom role we can't resolve in-memory.
    expect(
      resolveBuiltinRolePermission(
        "user,billing-manager",
        { self: ["TOOL_A"] },
        STATEMENTS,
      ),
    ).toBe("fallback");
    // Even an all-built-in comma string falls back — conservative by design.
    expect(
      resolveBuiltinRolePermission(
        "user,admin",
        { self: ["TOOL_A"] },
        STATEMENTS,
      ),
    ).toBe("fallback");
  });

  it("falls back when the built-in statement is missing from the map", () => {
    expect(resolveBuiltinRolePermission("user", { self: ["TOOL_A"] }, {})).toBe(
      "fallback",
    );
  });
});

describe("getBuiltinRoleStatements", () => {
  it("builds user/admin/owner with the expected shape and no '*' in user.self", () => {
    const stmts = getBuiltinRoleStatements(["TOOL_X", "TOOL_Y"]);
    expect(Object.keys(stmts).sort()).toEqual(["admin", "owner", "user"]);
    const userStmt = stmts.user;
    const adminStmt = stmts.admin;
    const ownerStmt = stmts.owner;
    if (!userStmt || !adminStmt || !ownerStmt) {
      throw new Error("expected user/admin/owner statements");
    }
    // user.self must NEVER contain "*" — the wildcard fallback would otherwise
    // grant every member full access (see registry-metadata USER_ROLE_TOOLS).
    expect(userStmt.self).not.toContain("*");
    // admin/owner enumerate "*" plus the full tool list (creator-role gating).
    expect(adminStmt.self).toContain("*");
    expect(adminStmt.self).toContain("TOOL_X");
    expect(ownerStmt.self).toEqual(adminStmt.self);
    // user carries the org-plugin memberAc keys (organization/member/.../ac).
    expect(userStmt.ac).toEqual(["read"]);
    expect(userStmt).toHaveProperty("member");
  });
});
