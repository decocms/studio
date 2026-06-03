import { describe, expect, test } from "bun:test";
import { ForbiddenError } from "../../core/access-control";
import type { StudioContext } from "../../core/studio-context";
import { requireOrgAdminForPinnedField } from "./require-org-admin-for-pin";

function ctxWithRole(role: string | undefined): StudioContext {
  return {
    access: {
      getRole: () => role,
    },
  } as StudioContext;
}

describe("requireOrgAdminForPinnedField", () => {
  test("allows owner and admin", () => {
    expect(() =>
      requireOrgAdminForPinnedField(ctxWithRole("owner")),
    ).not.toThrow();
    expect(() =>
      requireOrgAdminForPinnedField(ctxWithRole("admin")),
    ).not.toThrow();
  });

  test("rejects member and missing role", () => {
    expect(() => requireOrgAdminForPinnedField(ctxWithRole("user"))).toThrow(
      ForbiddenError,
    );
    expect(() => requireOrgAdminForPinnedField(ctxWithRole(undefined))).toThrow(
      ForbiddenError,
    );
  });
});
