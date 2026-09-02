import { describe, expect, it, mock } from "bun:test";
import { WellKnownOrgMCPId } from "@decocms/shared/sdk";
import { COLLECTION_CONNECTIONS_DELETE } from "./delete";

function makeCtx(options: { referencedByThread: boolean }) {
  const connection = {
    id: "conn_repo",
    organization_id: "org_123",
    metadata: null,
  };
  const deleteConnection = mock(async () => {});
  const isReferencedByThread = mock(async () => options.referencedByThread);
  const ctx = {
    auth: { user: { id: "user_123" } },
    organization: { id: "org_123" },
    access: { check: mock(async () => {}) },
    storage: {
      connections: {
        findById: mock(async () => connection),
        delete: deleteConnection,
        isReferencedByThread,
      },
      virtualMcps: { listByConnectionId: mock(async () => []) },
      organizationSettings: { get: mock(async () => null) },
    },
  } as unknown as Parameters<typeof COLLECTION_CONNECTIONS_DELETE.handler>[1];
  return { ctx, deleteConnection, isReferencedByThread };
}

describe("COLLECTION_CONNECTIONS_DELETE", () => {
  it("refuses to delete the synthetic dev-assets connection with a clear error", async () => {
    // Regression: findById() can't see it, so this used to say "not found".
    const { ctx, deleteConnection } = makeCtx({ referencedByThread: false });
    const devAssetsId = WellKnownOrgMCPId.DEV_ASSETS("org_123");

    await expect(
      COLLECTION_CONNECTIONS_DELETE.handler({ id: devAssetsId }, ctx),
    ).rejects.toThrow(/fixed system connection/);

    expect(deleteConnection).not.toHaveBeenCalled();
  });

  it("refuses to delete a connection a thread is pinned to as its repo", async () => {
    // Regression: deleting it would strand the thread's sandbox permanently.
    const { ctx, deleteConnection } = makeCtx({ referencedByThread: true });

    await expect(
      COLLECTION_CONNECTIONS_DELETE.handler({ id: "conn_repo" }, ctx),
    ).rejects.toThrow(/CONNECTION_IN_USE_BY_THREAD/);

    expect(deleteConnection).not.toHaveBeenCalled();
  });

  it("deletes a connection with no thread pinned to it", async () => {
    const { ctx, deleteConnection } = makeCtx({ referencedByThread: false });

    const result = await COLLECTION_CONNECTIONS_DELETE.handler(
      { id: "conn_repo" },
      ctx,
    );

    expect(result.item.id).toBe("conn_repo");
    expect(deleteConnection).toHaveBeenCalledWith("conn_repo");
  });
});
