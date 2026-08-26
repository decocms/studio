import { describe, expect, it, mock } from "bun:test";
import { ORGANIZATION_UPDATE } from "./update";

function makeCtx() {
  const update = mock(
    async (data: { organizationId: string; data: unknown }) => ({
      id: data.organizationId,
      name: "Acme",
      slug: "acme",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    }),
  );
  return {
    auth: { user: { id: "user-1" } },
    access: { check: mock(async () => {}) },
    organization: { id: "org-1", slug: "acme", name: "Acme" },
    boundAuth: { organization: { update } },
    update,
  } as unknown as Parameters<typeof ORGANIZATION_UPDATE.handler>[1] & {
    update: typeof update;
  };
}

describe("ORGANIZATION_UPDATE", () => {
  it("persists an explicit empty description instead of dropping it", async () => {
    const ctx = makeCtx();

    await ORGANIZATION_UPDATE.handler({ id: "org-1", description: "" }, ctx);

    expect(ctx.update).toHaveBeenCalledWith({
      organizationId: "org-1",
      data: { metadata: { description: "" } },
    });
  });

  it("still writes a non-empty description", async () => {
    const ctx = makeCtx();

    await ORGANIZATION_UPDATE.handler(
      { id: "org-1", description: "hello" },
      ctx,
    );

    expect(ctx.update).toHaveBeenCalledWith({
      organizationId: "org-1",
      data: { metadata: { description: "hello" } },
    });
  });

  it("rejects updating an organization other than the authenticated one", async () => {
    const ctx = makeCtx();

    await expect(
      ORGANIZATION_UPDATE.handler({ id: "org-2", name: "Evil" }, ctx),
    ).rejects.toThrow(
      "Organization ID does not match authenticated organization",
    );
    expect(ctx.update.mock.calls.length).toBe(0);
  });
});
