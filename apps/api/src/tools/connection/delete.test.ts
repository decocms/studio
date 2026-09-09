import { describe, expect, it, mock } from "bun:test";
import { WellKnownOrgMCPId } from "@decocms/shared/sdk";
import {
  clearRefreshBackoff,
  refreshAndStore,
} from "../../oauth/token-refresh";
import { COLLECTION_CONNECTIONS_DELETE } from "./delete";

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

  it("clears the oauth refresh backoff tracker on delete", async () => {
    // Regression: an unbounded tracker entry lingered past delete, suppressing a reconnect's first refresh.
    const { ctx } = makeCtx({ referencedByThread: false });
    const tokenStorage = {
      get: async () => null,
      delete: async () => {},
      isExpired: () => false,
      upsert: async () => ({}) as never,
    };
    const unrefreshableToken = {
      id: "dtok_1",
      connectionId: "conn_repo",
      accessToken: "old",
      refreshToken: null,
      scope: null,
      expiresAt: null,
      createdAt: "",
      updatedAt: "",
      clientId: null,
      clientSecret: null,
      tokenEndpoint: null,
    };
    // Arms the backoff window without a network call (no refresh_token to try).
    await refreshAndStore(unrefreshableToken, tokenStorage);

    await COLLECTION_CONNECTIONS_DELETE.handler({ id: "conn_repo" }, ctx);

    const originalFetch = global.fetch;
    let fetchCalled = false;
    global.fetch = mock(async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ access_token: "new" }));
    }) as unknown as typeof fetch;
    try {
      await refreshAndStore(
        {
          ...unrefreshableToken,
          refreshToken: "rt",
          clientId: "cid",
          tokenEndpoint: "https://example.com/token",
        },
        tokenStorage,
      );
    } finally {
      global.fetch = originalFetch;
      clearRefreshBackoff("conn_repo");
    }
    expect(fetchCalled).toBe(true);
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
