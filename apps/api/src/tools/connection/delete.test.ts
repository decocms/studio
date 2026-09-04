import { describe, expect, it, mock } from "bun:test";
import { WellKnownOrgMCPId } from "@decocms/shared/sdk";

const mockClearRefreshBackoff = mock((_connectionId?: string) => {});
mock.module("../../oauth/token-refresh", () => ({
  clearRefreshBackoff: mockClearRefreshBackoff,
}));

const { COLLECTION_CONNECTIONS_DELETE } = await import("./delete");

function makeCtx(options: {
  referencedByThread: boolean;
  referencingAutomations?: { id: string; name: string }[];
}) {
  const connection = {
    id: "conn_repo",
    organization_id: "org_123",
    metadata: null,
  };
  const deleteConnection = mock(async () => {});
  const isReferencedByThread = mock(async () => options.referencedByThread);
  const deactivateAutomation = mock(async () => {});
  const deleteTokenByConnection = mock(async () => {});
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
      automations: {
        listActiveByEventTriggerConnectionId: mock(
          async () => options.referencingAutomations ?? [],
        ),
        deactivateAutomation,
      },
      organizationSettings: { get: mock(async () => null) },
      triggerCallbackTokens: { deleteByConnection: deleteTokenByConnection },
    },
  } as unknown as Parameters<typeof COLLECTION_CONNECTIONS_DELETE.handler>[1];
  return {
    ctx,
    deleteConnection,
    isReferencedByThread,
    deactivateAutomation,
    deleteTokenByConnection,
  };
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

  it("clears the token-refresh backoff entry on delete", async () => {
    // Regression: the backoff map has no TTL and would leak this connectionId forever otherwise.
    mockClearRefreshBackoff.mockClear();
    const { ctx } = makeCtx({ referencedByThread: false });

    await COLLECTION_CONNECTIONS_DELETE.handler({ id: "conn_repo" }, ctx);

    expect(mockClearRefreshBackoff).toHaveBeenCalledWith("conn_repo");
  });

  it("revokes the connection's trigger callback token on delete", async () => {
    // Regression: trigger_callback_tokens.connection_id has no FK and stayed valid forever.
    const { ctx, deleteTokenByConnection } = makeCtx({
      referencedByThread: false,
    });

    await COLLECTION_CONNECTIONS_DELETE.handler({ id: "conn_repo" }, ctx);

    expect(deleteTokenByConnection).toHaveBeenCalledWith(
      "conn_repo",
      "org_123",
    );
  });

  it("refuses to delete a connection with an active automation event trigger", async () => {
    // Regression: automation_triggers.connection_id has no FK and would strand silently.
    const { ctx, deleteConnection } = makeCtx({
      referencedByThread: false,
      referencingAutomations: [{ id: "auto_1", name: "Notify on PR" }],
    });

    await expect(
      COLLECTION_CONNECTIONS_DELETE.handler({ id: "conn_repo" }, ctx),
    ).rejects.toThrow(/CONNECTION_IN_USE_BY_AUTOMATION/);

    expect(deleteConnection).not.toHaveBeenCalled();
  });

  it("force-deletes a connection by deactivating its referencing automations", async () => {
    const { ctx, deleteConnection, deactivateAutomation } = makeCtx({
      referencedByThread: false,
      referencingAutomations: [{ id: "auto_1", name: "Notify on PR" }],
    });

    const result = await COLLECTION_CONNECTIONS_DELETE.handler(
      { id: "conn_repo", force: true },
      ctx,
    );

    expect(result.item.id).toBe("conn_repo");
    expect(deactivateAutomation).toHaveBeenCalledWith("auto_1");
    expect(deleteConnection).toHaveBeenCalledWith("conn_repo");
  });
});
