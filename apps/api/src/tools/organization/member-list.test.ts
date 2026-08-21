import { describe, expect, it, mock } from "bun:test";
import { ORGANIZATION_MEMBER_LIST } from "./member-list";

function makeCtx() {
  const listMembers = mock(async () => ({
    members: [
      {
        id: "member-1",
        organizationId: "org-a",
        userId: "user-1",
        role: "admin",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ],
    total: 1,
  }));
  const ctx = {
    auth: { user: { id: "user-1" } },
    organization: { id: "org-a" },
    access: { check: mock(async () => {}) },
    boundAuth: { organization: { listMembers } },
  } as unknown as Parameters<typeof ORGANIZATION_MEMBER_LIST.handler>[1];
  return { ctx, listMembers };
}

describe("ORGANIZATION_MEMBER_LIST", () => {
  it("returns the members from Better Auth's { members, total } response", async () => {
    // Regression: this used to only accept a bare array, so it always returned [].
    const { ctx } = makeCtx();

    const result = await ORGANIZATION_MEMBER_LIST.handler({}, ctx);

    expect(result.members).toHaveLength(1);
    expect(result.members[0]).toMatchObject({
      id: "member-1",
      userId: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
