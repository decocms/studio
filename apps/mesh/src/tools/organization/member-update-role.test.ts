import { describe, expect, it } from "bun:test";
import { ORGANIZATION_MEMBER_UPDATE_ROLE } from "./member-update-role";

describe("ORGANIZATION_MEMBER_UPDATE_ROLE outputSchema", () => {
  const base = {
    id: "member-1",
    organizationId: "org-1",
    userId: "user-1",
    createdAt: new Date().toISOString(),
    user: { email: "a@b.com", name: "A" },
  };

  it("accepts a custom (non-builtin) role name", () => {
    // Regression: the schema used to hardcode role to
    // z.union([literal("admin"), literal("member"), literal("owner")]),
    // which made the MCP SDK reject the tool's own successful result for
    // any org-defined custom role (e.g. "editor") with an output
    // validation error, even though the DB write already succeeded.
    const result = ORGANIZATION_MEMBER_UPDATE_ROLE.outputSchema.safeParse({
      ...base,
      role: "editor",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a multi-role array, matching Better Auth's return shape", () => {
    const result = ORGANIZATION_MEMBER_UPDATE_ROLE.outputSchema.safeParse({
      ...base,
      role: ["user", "admin"],
    });
    expect(result.success).toBe(true);
  });
});
