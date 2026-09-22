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

  it("blocks demoting the organization's last owner", async () => {
    const updateMemberRole = mock(async () => ({}));
    // rows: caller membership, then target member, then all org members.
    const rows: unknown[] = [
      { role: "owner" },
      { role: "owner" },
      [{ role: "owner" }, { role: "user" }],
    ];
    let call = 0;
    const ctx = {
      auth: { user: { id: "user-1" } },
      access: { check: mock(async () => {}) },
      organization: { id: "org-1", slug: "acme", name: "Acme" },
      db: {
        selectFrom: () => ({
          select: () => ({
            where: () => ({
              where: () => ({
                executeTakeFirst: async () => rows[call++],
              }),
              execute: async () => rows[call++],
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
        { organizationId: "org-1", memberId: "member-1", role: ["user"] },
        ctx,
      ),
    ).rejects.toThrow("Cannot remove the organization's last owner");
    expect(updateMemberRole.mock.calls.length).toBe(0);
  });

  it("allows demoting an owner when another owner remains", async () => {
    const updateMemberRole = mock(async () => ({
      id: "member-1",
      organizationId: "org-1",
      userId: "user-2",
      role: "user",
      createdAt: new Date(),
      user: { email: "b@b.com", name: "B" },
    }));
    const rows: unknown[] = [
      { role: "owner" },
      { role: "owner" },
      [{ role: "owner" }, { role: "owner" }],
    ];
    let call = 0;
    const ctx = {
      auth: { user: { id: "user-1" } },
      access: { check: mock(async () => {}) },
      organization: { id: "org-1", slug: "acme", name: "Acme" },
      db: {
        selectFrom: () => ({
          select: () => ({
            where: () => ({
              where: () => ({
                executeTakeFirst: async () => rows[call++],
              }),
              execute: async () => rows[call++],
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
        { organizationId: "org-1", memberId: "member-1", role: ["user"] },
        ctx,
      ),
    ).resolves.toMatchObject({ userId: "user-2" });
    expect(updateMemberRole.mock.calls.length).toBe(1);
  });
});
