import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { SandboxMap, SandboxRecord } from "@decocms/shared/sdk";
import type { StudioContext } from "../../core/studio-context";
import type { AgentSandboxProvider } from "@decocms/sandbox/provider/agent-sandbox";

// Mock the hosted teardown runner before importing SANDBOX_DELETE.
const mockDelete = mock(async (_handle: string): Promise<void> => {});

async function* readyOnly() {
  yield { kind: "ready" as const };
}

const mockRunner: Pick<
  AgentSandboxProvider,
  | "alive"
  | "delete"
  | "ensure"
  | "getPreviewUrl"
  | "proxyDaemonRequest"
  | "watchClaimLifecycle"
> = {
  ensure: async () => ({
    handle: "_unused",
    workdir: "/app",
    previewUrl: null,
  }),
  delete: (h) => mockDelete(h),
  alive: async () => true,
  getPreviewUrl: async () => null,
  proxyDaemonRequest: async () => new Response(null, { status: 204 }),
  watchClaimLifecycle: () => readyOnly(),
};

mock.module("../../sandbox/lifecycle", () => ({
  getAgentSandboxProviderForTeardown: async () => mockRunner,
}));

const { SANDBOX_DELETE } = await import("./delete");

const BRANCH = "feat/example";

const HOSTED_ENTRY: SandboxRecord = {
  sandboxHandle: "f9e2fadeb813e08eb00eef6f962be2b2",
  previewUrl: "https://f9e2fadeb813e08eb00eef6f962be2b2.sandboxes.example.com/",
};

const DESKTOP_ENTRY: SandboxRecord = {
  sandboxHandle: "desktop-handle",
  previewUrl: "http://desktop-handle.localhost:5174/",
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
  kind: "agent-sandbox" | "local-api",
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
}): StudioContext {
  const {
    orgId = "org_1",
    userId = "user-1",
    virtualMcp,
    updateSpy = mock(async () => {}),
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
  });

  it("calls runner.delete with the entry's handle and removes sandboxMap entry", async () => {
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

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const updateCall = (updateSpy.mock.calls as unknown[][])[0]!;
    const updated = (updateCall[2] as { metadata: { sandboxMap: SandboxMap } })
      .metadata;
    // After removal, the user bucket should be gone entirely.
    expect(updated.sandboxMap["user-1"]).toBeUndefined();
  });

  it("does not route a native desktop entry through the hosted provider", async () => {
    const metadata: Metadata = {
      sandboxMap: makeSandboxMap("user-1", BRANCH, "local-api", DESKTOP_ENTRY),
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
    expect(mockDelete).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("preserves a native desktop sibling when deleting the hosted entry", async () => {
    const metadata: Metadata = {
      sandboxMap: {
        "user-1": {
          [BRANCH]: {
            "agent-sandbox": HOSTED_ENTRY,
            "local-api": DESKTOP_ENTRY,
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
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const updateCall = (updateSpy.mock.calls as unknown[][])[0]!;
    const updated = (updateCall[2] as { metadata: { sandboxMap: SandboxMap } })
      .metadata;
    expect(updated.sandboxMap["user-1"]?.[BRANCH]).toEqual({
      "local-api": DESKTOP_ENTRY,
    });
  });

  it("skips runner.delete and DB update when no hosted entry exists", async () => {
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
