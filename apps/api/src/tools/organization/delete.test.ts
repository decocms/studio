import { describe, expect, it, mock } from "bun:test";
import { ORGANIZATION_DELETE } from "./delete";

function makeCtx(existingMetadata: unknown) {
  const get = mock(async () => ({
    id: "org-1",
    name: "Acme",
    slug: "acme",
    metadata: existingMetadata,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  }));
  const update = mock(
    async (data: { organizationId: string; data: unknown }) => ({
      id: data.organizationId,
    }),
  );
  return {
    auth: { user: { id: "user-1" } },
    access: { check: mock(async () => {}) },
    boundAuth: { organization: { get, update } },
    get,
    update,
  } as unknown as Parameters<typeof ORGANIZATION_DELETE.handler>[1] & {
    get: typeof get;
    update: typeof update;
  };
}

describe("ORGANIZATION_DELETE", () => {
  it("preserves existing metadata when archiving", async () => {
    const ctx = makeCtx({ description: "an acme org" });

    await ORGANIZATION_DELETE.handler({ id: "org-1" }, ctx);

    const call = ctx.update.mock.calls[0]?.[0] as {
      data: { metadata: Record<string, unknown> };
    };
    expect(call.data.metadata.description).toBe("an acme org");
    expect(call.data.metadata.archived).toBe(true);
    expect(typeof call.data.metadata.archivedAt).toBe("string");
  });

  it("archives fine when there's no prior metadata", async () => {
    const ctx = makeCtx(undefined);

    await ORGANIZATION_DELETE.handler({ id: "org-1" }, ctx);

    const call = ctx.update.mock.calls[0]?.[0] as {
      data: { metadata: Record<string, unknown> };
    };
    expect(call.data.metadata.archived).toBe(true);
  });
});
