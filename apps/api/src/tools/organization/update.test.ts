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

    await ORGANIZATION_UPDATE.handler({ description: "" }, ctx);

    expect(ctx.update).toHaveBeenCalledWith({
      organizationId: "org-1",
      data: { metadata: { description: "" } },
    });
  });

  it("still writes a non-empty description", async () => {
    const ctx = makeCtx();

    await ORGANIZATION_UPDATE.handler({ description: "hello" }, ctx);

    expect(ctx.update).toHaveBeenCalledWith({
      organizationId: "org-1",
      data: { metadata: { description: "hello" } },
    });
  });

  it("always targets the organization resolved from the request context", async () => {
    const ctx = makeCtx();

    await ORGANIZATION_UPDATE.handler({ name: "Renamed" }, ctx);

    expect(ctx.update).toHaveBeenCalledWith({
      organizationId: "org-1",
      data: { name: "Renamed" },
    });
  });
});
