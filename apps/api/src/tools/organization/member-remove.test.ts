import { describe, expect, it, mock } from "bun:test";
import { ORGANIZATION_MEMBER_REMOVE } from "./member-remove";

function makeCtx(organization: { id: string } | undefined) {
  const removeMember = mock(async () => {});
  const ctx = {
    auth: { user: { id: "user-1" } },
    organization,
    access: { check: mock(async () => {}) },
    boundAuth: { organization: { removeMember } },
  } as unknown as Parameters<typeof ORGANIZATION_MEMBER_REMOVE.handler>[1];
  return { ctx, removeMember };
}

describe("ORGANIZATION_MEMBER_REMOVE", () => {
  it("rejects a removal scoped to a different organization than the context", async () => {
    // Regression: `input.organizationId` was used to call
    // `boundAuth.organization.removeMember` without ever checking it matched
    // `ctx.organization` — `ctx.access.check()` only verifies the caller's
    // permissions in `ctx.organization`, so a caller could remove a member
    // from an unrelated org they have no membership in at all.
    const { ctx, removeMember } = makeCtx({ id: "org-a" });

    await expect(
      ORGANIZATION_MEMBER_REMOVE.handler(
        { organizationId: "org-b", memberIdOrEmail: "victim@example.com" },
        ctx,
      ),
    ).rejects.toThrow(/does not match/i);

    expect(removeMember).not.toHaveBeenCalled();
  });

  it("allows a removal matching the context's organization", async () => {
    const { ctx, removeMember } = makeCtx({ id: "org-a" });

    const result = await ORGANIZATION_MEMBER_REMOVE.handler(
      { organizationId: "org-a", memberIdOrEmail: "member@example.com" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(removeMember).toHaveBeenCalledWith({
      organizationId: "org-a",
      memberIdOrEmail: "member@example.com",
    });
  });
});
