import { describe, expect, it, mock } from "bun:test";
import { ORGANIZATION_UPDATE } from "./update";

function makeCtx() {
  const get = mock(async () => ({
    id: "org-1",
    slug: "acme",
    name: "Acme",
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  }));
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
    boundAuth: { organization: { get, update } },
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

  it("merges description into existing metadata instead of replacing it", async () => {
    const get = mock(async () => ({
      id: "org-1",
      slug: "acme",
      name: "Acme",
      metadata: {
        archived: true,
        archivedAt: "2026-01-01T00:00:00Z",
      },
      createdAt: new Date("2026-01-01T00:00:00Z"),
    }));
    const update = mock(
      async (data: { organizationId: string; data: unknown }) => ({
        id: data.organizationId,
        name: "Acme",
        slug: "acme",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      }),
    );
    const ctx = {
      auth: { user: { id: "user-1" } },
      access: { check: mock(async () => {}) },
      organization: { id: "org-1" },
      boundAuth: { organization: { get, update } },
    } as unknown as Parameters<typeof ORGANIZATION_UPDATE.handler>[1];

    await ORGANIZATION_UPDATE.handler(
      { id: "org-1", description: "new desc" },
      ctx,
    );

    expect(update).toHaveBeenCalledWith({
      organizationId: "org-1",
      data: {
        metadata: {
          archived: true,
          archivedAt: "2026-01-01T00:00:00Z",
          description: "new desc",
        },
      },
    });
  });
});
