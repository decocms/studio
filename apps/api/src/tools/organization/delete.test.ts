import { describe, expect, it, mock } from "bun:test";
import { Kysely, PostgresAdapter, PostgresQueryCompiler } from "kysely";
import { ORGANIZATION_DELETE } from "./delete";

// Compiles `sql` raw queries without a live connection.
function fakeDb(executeQuery: (query: unknown) => Promise<{ rows: never[] }>) {
  return new Kysely({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createQueryCompiler: () => new PostgresQueryCompiler(),
      createIntrospector: () => ({}) as never,
      createDriver: () => ({
        init: async () => {},
        acquireConnection: async () => ({
          executeQuery,
          streamQuery: () => {
            throw new Error("not implemented");
          },
        }),
        beginTransaction: async () => {},
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        releaseConnection: async () => {},
        destroy: async () => {},
      }),
    },
  });
}

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
  const executeQuery = mock(async (_query: unknown) => ({
    rows: [] as never[],
  }));
  return {
    auth: { user: { id: "user-1" } },
    access: { check: mock(async () => {}) },
    organization: { id: "org-1", slug: "acme", name: "Acme" },
    boundAuth: { organization: { get, update } },
    db: fakeDb(executeQuery),
    get,
    update,
    executeQuery,
  } as unknown as Parameters<typeof ORGANIZATION_DELETE.handler>[1] & {
    get: typeof get;
    update: typeof update;
    executeQuery: typeof executeQuery;
  };
}

describe("ORGANIZATION_DELETE", () => {
  it("preserves existing metadata when archiving", async () => {
    const ctx = makeCtx({ description: "an acme org" });

    await ORGANIZATION_DELETE.handler({}, ctx);

    const call = ctx.update.mock.calls[0]?.[0] as {
      data: { metadata: Record<string, unknown> };
    };
    expect(call.data.metadata.description).toBe("an acme org");
    expect(call.data.metadata.archived).toBe(true);
    expect(typeof call.data.metadata.archivedAt).toBe("string");

    const query = ctx.executeQuery.mock.calls[0]?.[0] as { sql: string };
    expect(query.sql).toContain('update session set "activeOrganizationId"');
  });

  it("archives fine when there's no prior metadata", async () => {
    const ctx = makeCtx(undefined);

    await ORGANIZATION_DELETE.handler({}, ctx);

    const call = ctx.update.mock.calls[0]?.[0] as {
      data: { metadata: Record<string, unknown> };
    };
    expect(call.data.metadata.archived).toBe(true);
  });

  it("archives the organization resolved from the request context", async () => {
    const ctx = makeCtx(undefined);

    await ORGANIZATION_DELETE.handler({}, ctx);

    expect(ctx.get).toHaveBeenCalledWith("org-1");
    expect(
      (ctx.update.mock.calls[0]?.[0] as { organizationId: string })
        .organizationId,
    ).toBe("org-1");
  });

  it("is a no-op when the org is already archived, keeping the original archivedAt", async () => {
    const ctx = makeCtx({ archived: true, archivedAt: "2026-01-01T00:00:00Z" });

    await ORGANIZATION_DELETE.handler({ id: "org-1" }, ctx);

    expect(ctx.update.mock.calls.length).toBe(0);
    expect(ctx.executeQuery.mock.calls.length).toBe(0);
  });
});
