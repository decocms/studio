import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { SandboxMap, SandboxRecord } from "@decocms/shared/sdk";
import type { StudioContext } from "../../core/studio-context";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";

// Mock the one hosted runner BEFORE importing SANDBOX_DELETE.
const mockDelete = mock(async (_handle: string): Promise<void> => {});

async function* readyOnly() {
  yield { kind: "ready" as const };
}

const mockRunner = {
  ensure: async () => ({
    handle: "_unused",
    workdir: "/app",
    previewUrl: null,
  }),
  delete: (handle: string) => mockDelete(handle),
  alive: async () => true,
  getPreviewUrl: async () => null,
  proxyDaemonRequest: async () => new Response(null, { status: 204 }),
  adoptLiveClaim: async () => false,
  watchClaimLifecycle: () => readyOnly(),
};

const mockGetAgentSandboxProvider = mock(async (_ctx: unknown) => mockRunner);
const mockGetAgentSandboxProviderForTeardown = mock(
  async (_ctx: unknown) => mockRunner,
);

mock.module("../../sandbox/lifecycle", () => ({
  getAgentSandboxProvider: mockGetAgentSandboxProvider,
  getAgentSandboxProviderForTeardown: mockGetAgentSandboxProviderForTeardown,
  getOrInitAgentSandboxProvider: async () => mockRunner,
  subscribeLifecycle: () => ({ unsubscribe: () => {} }),
  __resetSharedLifecyclesForTesting: () => {},
}));

const { SANDBOX_DELETE } = await import("./delete");

const BRANCH = "feat/example";

const HOSTED_ENTRY: SandboxRecord = {
  sandboxHandle: "f9e2fadeb813e08eb00eef6f962be2b2",
  previewUrl: "https://f9e2fadeb813e08eb00eef6f962be2b2.sandboxes.example.com/",
  sandboxProviderKind: "agent-sandbox",
};

const DESKTOP_ENTRY: SandboxRecord = {
  sandboxHandle: "desktop-handle",
  previewUrl: "http://desktop-handle.localhost:5174/",
  sandboxProviderKind: "user-desktop",
};

/**
 * 3-level helper: builds sandboxMap[userId][branch][kind] = entry.
 * Type-cast through `unknown` is needed because SandboxMap's value type is a union
 * that doesn't yet include the record-of-entries shape before the full SDK
 * update lands; the runtime shape is correct.
 */
function makeSandboxMap(
  userId: string,
  branch: string,
  kind: SandboxProviderKind,
  entry: SandboxRecord,
): SandboxMap {
  return {
    [userId]: {
      [branch]: { [kind]: entry } as SandboxMap[string][string],
    },
  };
}

type Metadata = { sandboxMap?: SandboxMap };

function makeVirtualMcp(orgId: string, metadata: Metadata, id = "vmcp_1") {
  return {
    id,
    organization_id: orgId,
    metadata,
    title: "Test Virtual MCP",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "user_1",
  };
}

function makeCtx(overrides: {
  orgId?: string;
  userId?: string;
  virtualMcp?: ReturnType<typeof makeVirtualMcp> | null;
  updateSpy?: ReturnType<typeof mock>;
  thread?: {
    virtual_mcp_id?: string;
    created_by: string;
    metadata: Record<string, unknown>;
  } | null;
  threadUpdateSpy?: ReturnType<typeof mock>;
}): StudioContext {
  const {
    orgId = "org_1",
    userId = "user-1",
    virtualMcp,
    updateSpy = mock(async () => {}),
    thread = null,
    threadUpdateSpy = mock(async () => {}),
  } = overrides;

  const findById = mock(async (_id: string) => virtualMcp ?? null);

  return {
    auth: {
      user: {
        id: userId,
        email: "test@example.com",
        name: "Test",
        role: "user",
      },
    },
    organization: { id: orgId, slug: "test-org", name: "Test Org" },
    access: {
      granted: () => true,
      check: async () => {},
      grant: () => {},
      setToolName: () => {},
    },
    storage: {
      virtualMcps: { findById, update: updateSpy },
      threads: {
        get: mock(async (_id: string) =>
          thread
            ? {
                virtual_mcp_id: virtualMcp?.id ?? "vmcp_1",
                ...thread,
              }
            : null,
        ),
        update: threadUpdateSpy,
      },
    } as never,
    timings: {
      measure: async <T>(_name: string, cb: () => Promise<T>) => await cb(),
    },
    vault: null as never,
    authInstance: null as never,
    boundAuth: null as never,
    db: null as never,
    tracer: {
      startActiveSpan: (
        _name: string,
        _opts: unknown,
        fn: (span: unknown) => unknown,
      ) =>
        fn({
          setStatus: () => {},
          recordException: () => {},
          end: () => {},
        }),
    } as never,
    meter: {
      createHistogram: () => ({ record: () => {} }),
      createCounter: () => ({ add: () => {} }),
    } as never,
    baseUrl: "https://studio.example.com",
    metadata: { requestId: "req_1", timestamp: new Date() },
    objectStorage: null as never,
    aiProviders: null as never,
    createMCPProxy: null as never,
    getOrCreateClient: null as never,
    pendingRevalidations: [],
    monitoring: null as never,
  } as unknown as StudioContext;
}

describe("SANDBOX_DELETE", () => {
  beforeEach(() => {
    mockDelete.mockReset();
    mockDelete.mockImplementation(async () => {});
    mockGetAgentSandboxProvider.mockReset();
    mockGetAgentSandboxProvider.mockImplementation(async () => {
      throw new Error("Agent sandbox is not enabled");
    });
    mockGetAgentSandboxProviderForTeardown.mockReset();
    mockGetAgentSandboxProviderForTeardown.mockImplementation(
      async () => mockRunner,
    );
  });

  it("deletes the canonical agent sandbox with selectorless input", async () => {
    const metadata: Metadata = {
      sandboxMap: makeSandboxMap(
        "user-1",
        BRANCH,
        "agent-sandbox",
        HOSTED_ENTRY,
      ),
    };
    const virtualMcp = makeVirtualMcp("org_1", metadata);
    const updateSpy = mock(async () => {});
    const ctx = makeCtx({ virtualMcp, updateSpy });

    const result = await SANDBOX_DELETE.handler(
      {
        virtualMcpId: "vmcp_1",
        branch: BRANCH,
        removeWorktree: false,
      },
      ctx,
    );

    expect(result).toEqual({ success: true });
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith(HOSTED_ENTRY.sandboxHandle);
    expect(mockGetAgentSandboxProvider).not.toHaveBeenCalled();
    expect(mockGetAgentSandboxProviderForTeardown).toHaveBeenCalledTimes(1);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const updateCall = (updateSpy.mock.calls as unknown[][])[0]!;
    const updated = (updateCall[2] as { metadata: { sandboxMap: SandboxMap } })
      .metadata;
    // After removal, the user bucket should be gone entirely.
    expect(updated.sandboxMap["user-1"]).toBeUndefined();
  });

  it("rejects obsolete provider selectors from the input contract", () => {
    for (const sandboxProviderKind of [
      "agent-sandbox",
      "user-desktop",
      "cluster",
    ]) {
      expect(
        SANDBOX_DELETE.inputSchema.safeParse({
          virtualMcpId: "vmcp_1",
          branch: BRANCH,
          sandboxProviderKind,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects unexpected fields from the output contract", () => {
    expect(
      SANDBOX_DELETE.outputSchema.safeParse({ success: true }).success,
    ).toBe(true);
    expect(
      SANDBOX_DELETE.outputSchema.safeParse({
        success: true,
        sandboxProviderKind: "agent-sandbox",
      }).success,
    ).toBe(false);
  });

  it("removes the canonical entry while preserving a desktop sibling", async () => {
    const metadata: Metadata = {
      sandboxMap: {
        "user-1": {
          [BRANCH]: {
            "agent-sandbox": HOSTED_ENTRY,
            "user-desktop": DESKTOP_ENTRY,
          },
        },
      },
    };
    const virtualMcp = makeVirtualMcp("org_1", metadata);
    const updateSpy = mock(async () => {});
    const ctx = makeCtx({ virtualMcp, updateSpy });

    await SANDBOX_DELETE.handler(
      {
        virtualMcpId: "vmcp_1",
        branch: BRANCH,
        removeWorktree: false,
      },
      ctx,
    );

    expect(mockDelete).toHaveBeenCalledWith(HOSTED_ENTRY.sandboxHandle);
    expect(mockDelete).not.toHaveBeenCalledWith(DESKTOP_ENTRY.sandboxHandle);
    const updateCall = (updateSpy.mock.calls as unknown[][])[0]!;
    const updated = (updateCall[2] as { metadata: { sandboxMap: SandboxMap } })
      .metadata;
    const branchMap = updated.sandboxMap["user-1"]?.[BRANCH] as
      | Record<string, SandboxRecord>
      | undefined;
    expect(branchMap?.["agent-sandbox"]).toBeUndefined();
    expect(branchMap?.["user-desktop"]).toEqual(DESKTOP_ENTRY);
  });

  it("refuses to delete a teammate's thread sandbox", async () => {
    const branch = "thread:t1/conn_a";
    const virtualMcp = makeVirtualMcp("org_1", {});
    const threadUpdateSpy = mock(async () => {});
    const ctx = makeCtx({
      virtualMcp,
      userId: "user-viewer",
      threadUpdateSpy,
      thread: {
        created_by: "user-1",
        metadata: {
          sandboxMap: makeSandboxMap(
            "user-1",
            branch,
            "agent-sandbox",
            HOSTED_ENTRY,
          ),
        },
      },
    });

    await expect(
      SANDBOX_DELETE.handler(
        { virtualMcpId: "vmcp_1", branch, removeWorktree: false },
        ctx,
      ),
    ).rejects.toThrow("Only the thread owner can change its sandbox");

    expect(mockGetAgentSandboxProviderForTeardown).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(threadUpdateSpy).not.toHaveBeenCalled();
  });

  it("refuses a thread from another Virtual MCP", async () => {
    const branch = "thread:t1/conn_a";
    const virtualMcp = makeVirtualMcp("org_1", {});
    const threadUpdateSpy = mock(async () => {});
    const ctx = makeCtx({
      virtualMcp,
      threadUpdateSpy,
      thread: {
        virtual_mcp_id: "vmcp_other",
        created_by: "user-1",
        metadata: {
          sandboxMap: makeSandboxMap(
            "user-1",
            branch,
            "agent-sandbox",
            HOSTED_ENTRY,
          ),
        },
      },
    });

    await expect(
      SANDBOX_DELETE.handler(
        { virtualMcpId: "vmcp_1", branch, removeWorktree: false },
        ctx,
      ),
    ).rejects.toThrow("Thread not found for Virtual MCP");

    expect(mockGetAgentSandboxProviderForTeardown).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(threadUpdateSpy).not.toHaveBeenCalled();
  });

  it("does not delete the claim when clearing the thread record fails", async () => {
    const branch = "thread:t1/conn_a";
    const virtualMcp = makeVirtualMcp("org_1", {});
    const threadUpdateSpy = mock(async () => {
      throw new Error("thread update failed");
    });
    const ctx = makeCtx({
      virtualMcp,
      threadUpdateSpy,
      thread: {
        created_by: "user-1",
        metadata: {
          sandboxMap: makeSandboxMap(
            "user-1",
            branch,
            "agent-sandbox",
            HOSTED_ENTRY,
          ),
        },
      },
    });

    await expect(
      SANDBOX_DELETE.handler(
        { virtualMcpId: "vmcp_1", branch, removeWorktree: false },
        ctx,
      ),
    ).rejects.toThrow("Failed to clear agent sandbox records");

    expect(mockGetAgentSandboxProviderForTeardown).toHaveBeenCalledTimes(1);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("ignores a desktop-only record instead of sending its handle to the runner", async () => {
    const metadata: Metadata = {
      sandboxMap: makeSandboxMap(
        "user-1",
        BRANCH,
        "user-desktop",
        DESKTOP_ENTRY,
      ),
    };
    const virtualMcp = makeVirtualMcp("org_1", metadata);
    const updateSpy = mock(async () => {});
    const ctx = makeCtx({ virtualMcp, updateSpy });

    const result = await SANDBOX_DELETE.handler(
      {
        virtualMcpId: "vmcp_1",
        branch: BRANCH,
        removeWorktree: false,
      },
      ctx,
    );

    expect(result).toEqual({ success: true });
    expect(mockGetAgentSandboxProvider).not.toHaveBeenCalled();
    expect(mockGetAgentSandboxProviderForTeardown).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("ignores a desktop record stored under the agent-sandbox key", async () => {
    const metadata: Metadata = {
      sandboxMap: makeSandboxMap(
        "user-1",
        BRANCH,
        "agent-sandbox",
        DESKTOP_ENTRY,
      ),
    };
    const virtualMcp = makeVirtualMcp("org_1", metadata);
    const updateSpy = mock(async () => {});
    const ctx = makeCtx({ virtualMcp, updateSpy });

    const result = await SANDBOX_DELETE.handler(
      {
        virtualMcpId: "vmcp_1",
        branch: BRANCH,
        removeWorktree: false,
      },
      ctx,
    );

    expect(result).toEqual({ success: true });
    expect(mockGetAgentSandboxProvider).not.toHaveBeenCalled();
    expect(mockGetAgentSandboxProviderForTeardown).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("deletes a thread-only canonical record and preserves its desktop sibling", async () => {
    const branch = "thread:t1/conn_a";
    const virtualMcp = makeVirtualMcp("org_1", {});
    const updateSpy = mock(async () => {});
    const threadUpdateSpy = mock(async () => {});
    const ctx = makeCtx({
      virtualMcp,
      updateSpy,
      threadUpdateSpy,
      thread: {
        created_by: "user-1",
        metadata: {
          sandboxMap: {
            "user-1": {
              [branch]: {
                "agent-sandbox": HOSTED_ENTRY,
                "user-desktop": DESKTOP_ENTRY,
              },
            },
          },
        },
      },
    });

    const result = await SANDBOX_DELETE.handler(
      { virtualMcpId: "vmcp_1", branch, removeWorktree: false },
      ctx,
    );

    expect(result).toEqual({ success: true });
    expect(mockDelete).toHaveBeenCalledWith(HOSTED_ENTRY.sandboxHandle);
    expect(mockDelete).not.toHaveBeenCalledWith(DESKTOP_ENTRY.sandboxHandle);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(threadUpdateSpy).toHaveBeenCalledTimes(1);
    const updateCall = (threadUpdateSpy.mock.calls as unknown[][])[0]!;
    const updated = (updateCall[1] as { metadata: { sandboxMap: SandboxMap } })
      .metadata;
    const branchMap = updated.sandboxMap["user-1"]?.[branch] as
      | Record<string, SandboxRecord>
      | undefined;
    expect(branchMap?.["agent-sandbox"]).toBeUndefined();
    expect(branchMap?.["user-desktop"]).toEqual(DESKTOP_ENTRY);
  });

  it("skips runner.delete and DB update when this user has no canonical entry", async () => {
    // Entry exists for a different user — this user has no entry.
    const metadata: Metadata = {
      sandboxMap: makeSandboxMap(
        "other-user",
        BRANCH,
        "agent-sandbox",
        HOSTED_ENTRY,
      ),
    };
    const virtualMcp = makeVirtualMcp("org_1", metadata);
    const updateSpy = mock(async () => {});
    const ctx = makeCtx({ virtualMcp, updateSpy });

    const result = await SANDBOX_DELETE.handler(
      {
        virtualMcpId: "vmcp_1",
        branch: BRANCH,
        removeWorktree: false,
      },
      ctx,
    );

    expect(result).toEqual({ success: true });
    expect(mockGetAgentSandboxProvider).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("returns success when virtualMcp not found (null from findById)", async () => {
    const ctx = makeCtx({ virtualMcp: null });

    const result = await SANDBOX_DELETE.handler(
      {
        virtualMcpId: "vmcp_missing",
        branch: BRANCH,
        removeWorktree: false,
      },
      ctx,
    );

    expect(result).toEqual({ success: true });
    expect(mockGetAgentSandboxProvider).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("throws 'User ID required' when userId is unavailable", async () => {
    const metadata: Metadata = {};
    const virtualMcp = makeVirtualMcp("org_1", metadata);
    const ctx = makeCtx({ virtualMcp, userId: "" });

    (ctx as unknown as { auth: { user: { id: undefined } } }).auth.user.id =
      undefined;

    await expect(
      SANDBOX_DELETE.handler(
        {
          virtualMcpId: "vmcp_1",
          branch: BRANCH,
          removeWorktree: false,
        },
        ctx,
      ),
    ).rejects.toThrow("User ID required");
  });
});
