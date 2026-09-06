import { describe, expect, it, mock } from "bun:test";
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

describe("ORGANIZATION_MEMBER_UPDATE_ROLE handler", () => {
  it("rejects an organizationId other than the authenticated one", async () => {
    const updateMemberRole = mock(async () => ({}));
    const ctx = {
      auth: { user: { id: "user-1" } },
      access: { check: mock(async () => {}) },
      organization: { id: "org-1", slug: "acme", name: "Acme" },
      db: {
        selectFrom: () => ({
          select: () => ({
            where: () => ({
              where: () => ({
                executeTakeFirst: async () => ({ role: "owner" }),
              }),
            }),
          }),
        }),
      },
      boundAuth: { organization: { updateMemberRole } },
    } as unknown as Parameters<
      typeof ORGANIZATION_MEMBER_UPDATE_ROLE.handler
    >[1];

    await expect(
      ORGANIZATION_MEMBER_UPDATE_ROLE.handler(
        { organizationId: "org-2", memberId: "member-1", role: ["admin"] },
        ctx,
      ),
    ).rejects.toThrow(
      "Organization ID does not match authenticated organization",
    );
    expect(updateMemberRole.mock.calls.length).toBe(0);
  });
});
