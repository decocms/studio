import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { SandboxMap, SandboxRecord } from "@decocms/mesh-sdk";
import type { StudioContext } from "../../core/studio-context";
import type {
  EnsureOptions,
  Sandbox,
  SandboxId,
  SandboxProvider,
} from "@decocms/sandbox/provider";
import { composeSandboxRef } from "@decocms/sandbox/provider";

// Pin provider kind — the dev env flips STUDIO_SANDBOX_PROVIDER and SANDBOX_START
// reads it at handler time.
process.env.STUDIO_SANDBOX_PROVIDER = "agent-sandbox";

// Mock runner BEFORE importing SANDBOX_START — handler is runner-agnostic.

const mockEnsure = mock(
  async (_id: SandboxId, _opts?: EnsureOptions): Promise<Sandbox> => ({
    handle: "vm_xyz",
    workdir: "/app",
    previewUrl: "https://stub.preview/",
  }),
);

const mockClusterDelete = mock(async (_handle: string) => {});
const mockAgentSandboxDelete = mock(async (_handle: string) => {});

async function* readyOnly() {
  yield { kind: "ready" as const };
}

const mockClusterRunner: SandboxProvider = {
  kind: "agent-sandbox",
  ensure: (id, opts) => mockEnsure(id, opts),
  delete: (handle) => mockClusterDelete(handle),
  alive: async () => true,
  getPreviewUrl: async () => "https://stub.preview/",
  proxyDaemonRequest: async () => new Response(null, { status: 204 }),
  watchClaimLifecycle: () => readyOnly(),
};

const mockDesktopDelete = mock(async (_handle: string) => {});

const mockDesktopRunner: SandboxProvider = {
  kind: "user-desktop",
  ensure: (id, opts) => mockEnsure(id, opts),
  delete: (handle) => mockDesktopDelete(handle),
  alive: async () => true,
  getPreviewUrl: async () => "https://stub.preview/",
  proxyDaemonRequest: async () => new Response(null, { status: 204 }),
  watchClaimLifecycle: () => readyOnly(),
};

mock.module("../../sandbox/lifecycle", () => ({
  // Only ever invoked for the agent-sandbox kind — the desktop path goes through
  // `buildDesktopProvider` (below); user-desktop is never instantiated here.
  getSandboxProviderByKind: (
    _ctx: unknown,
    _kind: "agent-sandbox" | "user-desktop",
  ) => mockClusterRunner,
  // The unified resolver in `resolve-provider.ts` calls
  // `buildDesktopProvider` directly (no ctx side-effects), so a mock
  // is needed for SANDBOX_START's desktop path to construct the expected
  // runner under test.
  buildDesktopProvider: async () => mockDesktopRunner,
  getOrInitSharedRunner: async () => mockClusterRunner,
  // Bun's mock.module persists across test files in the same shard. Other
  // tests in the shard (e.g. oauth-proxy.e2e.test.ts) load app.ts which
  // imports subscribeLifecycle from this module — keep the export shape
  // complete so subsequent loads don't hit "Export named ... not found".
  subscribeLifecycle: () => ({ unsubscribe: () => {} }),
  __resetSharedLifecyclesForTesting: () => {},
}));

mock.module("../../settings", () => ({
  getSettings: () => ({ nodeEnv: "test" }),
}));

const { DownstreamTokenStorage: RealDownstreamTokenStorage } = await import(
  "../../storage/downstream-token"
);
import type { DownstreamTokenData } from "../../storage/downstream-token";
import type { DownstreamToken } from "../../storage/types";

const mockTokenGet = mock(
  async (_connectionId: string): Promise<DownstreamToken | null> => ({
    id: "dtok_1",
    connectionId: "conn_github_1",
    accessToken: "ghu_test_token_123",
    refreshToken: null,
    scope: null,
    expiresAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    clientId: null,
    clientSecret: null,
    tokenEndpoint: null,
  }),
);

const mockTokenUpsert = mock(async (_data: DownstreamTokenData) => {});
const mockTokenDelete = mock(async (_connectionId: string) => {});

mock.module("../../storage/downstream-token", () => ({
  DownstreamTokenStorage: class MockDownstreamTokenStorage extends RealDownstreamTokenStorage {
    override async get(connectionId: string) {
      if (connectionId === "conn_github_1") {
        return mockTokenGet(connectionId);
      }
      return super.get(connectionId);
    }
    override async upsert(data: DownstreamTokenData) {
      if (data.connectionId === "conn_github_1") {
        await mockTokenUpsert(data);
        return {
          id: "dtok_1",
          connectionId: data.connectionId,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          scope: data.scope,
          expiresAt: data.expiresAt,
          clientId: data.clientId,
          clientSecret: data.clientSecret,
          tokenEndpoint: data.tokenEndpoint,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      return super.upsert(data);
    }
    override async delete(connectionId: string) {
      if (connectionId === "conn_github_1") {
        await mockTokenDelete(connectionId);
        return;
      }
      return super.delete(connectionId);
    }
  },
}));

const mockRefreshAccessToken = mock(
  async (): Promise<{
    success: boolean;
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    scope?: string;
    error?: string;
  }> => ({ success: true, accessToken: "ghu_refreshed_token" }),
);
mock.module("@/oauth/refresh-access-token", () => ({
  refreshAccessToken: mockRefreshAccessToken,
}));

const { SANDBOX_START } = await import("./start");

const originalFetch = globalThis.fetch;

const BRANCH = "feat/example";
const ORG_ID = "org_1";
const VMCP_ID = "vmcp_1";
const USER_ID = "user_1";

const EXPECTED_REF = composeSandboxRef({
  orgId: ORG_ID,
  virtualMcpId: VMCP_ID,
  branch: BRANCH,
});

type Metadata = {
  githubRepo: { owner: string; name: string; connectionId: string };
  runtime: { selected: string; port: string; path?: string | null };
  sandboxMap?: SandboxMap;
};

const BASE_METADATA: Metadata = {
  githubRepo: {
    owner: "acme",
    name: "app",
    connectionId: "conn_github_1",
  },
  runtime: { selected: "npm", port: "3000" },
};

const CACHED_ENTRY: SandboxRecord = {
  sandboxHandle: "vm_cached",
  previewUrl: "https://cached.preview/",
};

function makeVirtualMcp(orgId: string, metadata: Metadata, id = VMCP_ID) {
  return {
    id,
    organization_id: orgId,
    metadata,
    title: "Test Virtual MCP",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: USER_ID,
  };
}

function makeCtx(overrides: {
  orgId?: string;
  userId?: string;
  virtualMcp?: ReturnType<typeof makeVirtualMcp> | null;
  updateSpy?: ReturnType<typeof mock>;
}): StudioContext {
  const {
    orgId = ORG_ID,
    userId = USER_ID,
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
      // Non-repo-scoped org connection: getRepoScope() returns null, so the
      // repo-scoped mint path in provisionSandbox is skipped and these tests
      // exercise the clone/token path unchanged. (Minting is covered by the
      // e2e suite, github-import-repo-scope.spec.ts.)
      connections: {
        findById: mock(async (_id: string) => ({ metadata: null })),
      },
      // A `thread:` branch resolves the thread's bound repo; return no thread so
      // provisioning falls back to the VM's own githubRepo.
      threads: {
        get: mock(async (_id: string) => null),
        update: mock(async () => {}),
      },
    } as never,
    timings: {
      measure: async <T>(_name: string, cb: () => Promise<T>) => await cb(),
    },
    vault: null as never,
    db: null as never,
    authInstance: null as never,
    boundAuth: null as never,
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
    baseUrl: "https://mesh.example.com",
    metadata: { requestId: "req_1", timestamp: new Date() },
    objectStorage: null as never,
    aiProviders: null as never,
    createMCPProxy: null as never,
    getOrCreateClient: null as never,
    pendingRevalidations: [],
    monitoring: null as never,
  } as unknown as StudioContext;
}

describe("SANDBOX_START", () => {
  beforeEach(() => {
    globalThis.fetch = mock(
      async () => new Response("{}", { status: 404 }),
    ) as unknown as typeof fetch;
    mockEnsure.mockReset();
    mockClusterDelete.mockReset();
    mockAgentSandboxDelete.mockReset();
    mockDesktopDelete.mockReset();
    mockClusterDelete.mockImplementation(async () => {});
    mockAgentSandboxDelete.mockImplementation(async () => {});
    mockDesktopDelete.mockImplementation(async () => {});
    mockTokenGet.mockReset();
    mockEnsure.mockImplementation(async () => ({
      handle: "vm_xyz",
      workdir: "/app",
      previewUrl: "https://stub.preview/",
    }));
    mockTokenGet.mockImplementation(async () => ({
      id: "dtok_1",
      connectionId: "conn_github_1",
      accessToken: "ghu_test_token_123",
      refreshToken: null,
      scope: null,
      expiresAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      clientId: null,
      clientSecret: null,
      tokenEndpoint: null,
    }));
    mockRefreshAccessToken.mockReset();
    mockRefreshAccessToken.mockImplementation(async () => ({
      success: true,
      accessToken: "ghu_refreshed_token",
    }));
    mockTokenUpsert.mockReset();
    mockTokenUpsert.mockImplementation(async () => {});
    mockTokenDelete.mockReset();
    mockTokenDelete.mockImplementation(async () => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls runner.ensure with composed projectRef + repo + workload", async () => {
    const virtualMcp = makeVirtualMcp(ORG_ID, BASE_METADATA);
    const updateSpy = mock(async () => {});
    const ctx = makeCtx({ virtualMcp, updateSpy });

    await SANDBOX_START.handler({ virtualMcpId: VMCP_ID, branch: BRANCH }, ctx);

    expect(mockTokenGet).toHaveBeenCalledWith("conn_github_1");
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    const [id, opts] = mockEnsure.mock.calls[0]! as [SandboxId, EnsureOptions];
    expect(id).toEqual({ userId: USER_ID, projectRef: EXPECTED_REF });
    expect(opts.repo?.cloneUrl).toContain("acme/app");
    expect(opts.repo?.branch).toBe(BRANCH);
    expect(opts.repo?.displayName).toBe("acme/app");
    expect(opts.workload).toEqual({
      runtime: "node",
      packageManager: "npm",
      devPort: 3000,
    });
  });

  it("sends a real git branch for a synthetic thread branch, keeping the ref synthetic", async () => {
    const virtualMcp = makeVirtualMcp(ORG_ID, BASE_METADATA);
    const ctx = makeCtx({ virtualMcp });
    const synthetic = "thread:t1/conn_a";

    await SANDBOX_START.handler(
      { virtualMcpId: VMCP_ID, branch: synthetic },
      ctx,
    );

    const [id, opts] = mockEnsure.mock.calls[0]! as [SandboxId, EnsureOptions];
    // Git config gets a REAL, non-default ref — so shutdown-sync persists to git
    // on its own branch, never `main`.
    expect(opts.repo?.branch).toBe("sandbox/thread-t1-conn_a");
    // Isolation stays synthetic: projectRef + handle key are unchanged, so
    // sandbox identity/reuse is stable across reboots.
    expect(opts.branch).toBe(synthetic);
    expect(id.projectRef).toBe(
      composeSandboxRef({
        orgId: ORG_ID,
        virtualMcpId: VMCP_ID,
        branch: synthetic,
      }),
    );
  });

  it("persists sandboxMap entry with handle + previewUrl + sandboxProviderKind", async () => {
    mockEnsure.mockImplementation(async () => ({
      handle: "vm_xyz",
      workdir: "/app",
      previewUrl: "https://stub.preview/",
    }));
    const virtualMcp = makeVirtualMcp(ORG_ID, BASE_METADATA);
    const updateSpy = mock(async () => {});
    const ctx = makeCtx({ virtualMcp, updateSpy });

    const result = await SANDBOX_START.handler(
      { virtualMcpId: VMCP_ID, branch: BRANCH },
      ctx,
    );

    expect(result.sandboxHandle).toBe("vm_xyz");
    expect(result.previewUrl).toBe("https://stub.preview/");
    expect(result.branch).toBe(BRANCH);
    expect(result.isNewVm).toBe(true);
    expect(result.sandboxProviderKind).toBe("agent-sandbox");

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const updateCall = (updateSpy.mock.calls as unknown[][])[0]!;
    const updated = (updateCall[2] as { metadata: { sandboxMap: SandboxMap } })
      .metadata;
    // 3-level key: sandboxMap[userId][branch][kind]
    const stored = (
      updated.sandboxMap[USER_ID]?.[BRANCH] as Record<string, unknown>
    )?.["agent-sandbox"];
    expect(stored).toMatchObject({
      sandboxHandle: "vm_xyz",
      previewUrl: "https://stub.preview/",
      sandboxProviderKind: "agent-sandbox",
    });
    // Server-stamped; assert recency, not exact value.
    expect(typeof (stored as SandboxRecord)?.createdAt).toBe("number");
    expect((stored as SandboxRecord)?.createdAt).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });

  it("snapshots metadata.runtime selected/port/path into startedWith", async () => {
    mockEnsure.mockImplementation(async () => ({
      handle: "vm_xyz",
      workdir: "/app",
      previewUrl: "https://stub.preview/",
    }));
    const metadata: Metadata = {
      ...BASE_METADATA,
      runtime: { selected: "pnpm", port: "4321", path: "apps/web" },
    };
    const virtualMcp = makeVirtualMcp(ORG_ID, metadata);
    const updateSpy = mock(async () => {});
    const ctx = makeCtx({ virtualMcp, updateSpy });

    await SANDBOX_START.handler({ virtualMcpId: VMCP_ID, branch: BRANCH }, ctx);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const updateCall = (updateSpy.mock.calls as unknown[][])[0]!;
    const updated = (updateCall[2] as { metadata: { sandboxMap: SandboxMap } })
      .metadata;
    // 3-level key: sandboxMap[userId][branch][kind]
    const stored = (
      updated.sandboxMap[USER_ID]?.[BRANCH] as Record<string, unknown>
    )?.["agent-sandbox"] as SandboxRecord | undefined;
    expect(stored?.startedWith).toEqual({
      packageManager: "pnpm",
      port: "4321",
      path: "apps/web",
    });
  });

  it("snapshots null selected/port/path when metadata.runtime is missing", async () => {
    mockEnsure.mockImplementation(async () => ({
      handle: "vm_xyz",
      workdir: "/app",
      previewUrl: "https://stub.preview/",
    }));
    // detectRepoRuntime probe will run when packageManager is unset; stub
    // it so it returns null and leaves metadata.runtime unchanged.
    const metadata = {
      githubRepo: BASE_METADATA.githubRepo,
    } as unknown as Metadata;
    const virtualMcp = makeVirtualMcp(ORG_ID, metadata);
    const updateSpy = mock(async () => {});
    const ctx = makeCtx({ virtualMcp, updateSpy });

    await SANDBOX_START.handler({ virtualMcpId: VMCP_ID, branch: BRANCH }, ctx);

    // Find the sandboxMap update (detectRepoRuntime may write a runtime update too).
    const sandboxMapCall = (updateSpy.mock.calls as unknown[][]).find(
      (call) => {
        const meta = (call[2] as { metadata?: { sandboxMap?: SandboxMap } })
          .metadata;
        return meta?.sandboxMap?.[USER_ID]?.[BRANCH] !== undefined;
      },
    );
    expect(sandboxMapCall).toBeDefined();
    const updated = (
      sandboxMapCall![2] as { metadata: { sandboxMap: SandboxMap } }
    ).metadata;
    // 3-level key: sandboxMap[userId][branch][kind]
    const stored = (
      updated.sandboxMap[USER_ID]?.[BRANCH] as Record<string, unknown>
    )?.["agent-sandbox"] as SandboxRecord | undefined;
    expect(stored?.startedWith).toEqual({
      packageManager: null,
      port: null,
      path: null,
    });
  });

  it("returns isNewVm=false when runner.ensure returns the same handle as the existing entry", async () => {
    mockEnsure.mockImplementation(async () => ({
      handle: CACHED_ENTRY.sandboxHandle,
      workdir: "/app",
      previewUrl: CACHED_ENTRY.previewUrl,
    }));
    const metadata: Metadata = {
      ...BASE_METADATA,
      // 3-level: kind (agent-sandbox) → entry
      sandboxMap: {
        [USER_ID]: { [BRANCH]: { "agent-sandbox": CACHED_ENTRY } },
      },
    };
    const virtualMcp = makeVirtualMcp(ORG_ID, metadata);
    const ctx = makeCtx({ virtualMcp });

    const result = await SANDBOX_START.handler(
      { virtualMcpId: VMCP_ID, branch: BRANCH },
      ctx,
    );

    expect(result.sandboxHandle).toBe(CACHED_ENTRY.sandboxHandle);
    expect(result.isNewVm).toBe(false);
  });

  it("generates a <creator-slug>-<timestamp> branch when input.branch is omitted and threads it into the ref", async () => {
    const virtualMcp = makeVirtualMcp(ORG_ID, BASE_METADATA);
    const updateSpy = mock(async () => {});
    const ctx = makeCtx({ virtualMcp, updateSpy });

    const result = await SANDBOX_START.handler({ virtualMcpId: VMCP_ID }, ctx);

    // <creator-slug>-<base36-timestamp>, no namespace prefix. Test user is "Test".
    expect(result.branch).toMatch(/^test-[0-9a-z]+$/);
    expect(result.branch.includes("/")).toBe(false);
    const [id] = mockEnsure.mock.calls[0]! as [SandboxId];
    expect(id.projectRef).toBe(
      composeSandboxRef({
        orgId: ORG_ID,
        virtualMcpId: VMCP_ID,
        branch: result.branch,
      }),
    );
  });

  it("propagates runner.ensure failures", async () => {
    mockEnsure.mockImplementation(async () => {
      throw new Error("runner blew up");
    });
    const virtualMcp = makeVirtualMcp(ORG_ID, BASE_METADATA);
    const ctx = makeCtx({ virtualMcp });

    await expect(
      SANDBOX_START.handler({ virtualMcpId: VMCP_ID, branch: BRANCH }, ctx),
    ).rejects.toThrow("runner blew up");
  });

  it("throws 'Virtual MCP not found' when findById returns null", async () => {
    const ctx = makeCtx({ virtualMcp: null });

    await expect(
      SANDBOX_START.handler(
        { virtualMcpId: "vmcp_missing", branch: BRANCH },
        ctx,
      ),
    ).rejects.toThrow("Virtual MCP not found");
  });

  it("throws 'Virtual MCP not found' when Virtual MCP belongs to a different org", async () => {
    const virtualMcp = makeVirtualMcp("org_other", BASE_METADATA);
    const ctx = makeCtx({ orgId: ORG_ID, virtualMcp });

    await expect(
      SANDBOX_START.handler({ virtualMcpId: VMCP_ID, branch: BRANCH }, ctx),
    ).rejects.toThrow("Virtual MCP not found");
  });

  it("throws when no GitHub token is found", async () => {
    // Override mock to exercise the missing-token branch.
    (
      mockTokenGet as unknown as {
        mockImplementation: (fn: () => Promise<null>) => void;
      }
    ).mockImplementation(async () => null);
    const virtualMcp = makeVirtualMcp(ORG_ID, BASE_METADATA);
    const ctx = makeCtx({ virtualMcp });

    await expect(
      SANDBOX_START.handler({ virtualMcpId: VMCP_ID, branch: BRANCH }, ctx),
    ).rejects.toThrow("No GitHub token found");
  });

  it("refreshes an expired GitHub token before handing it to the runner", async () => {
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    mockTokenGet.mockImplementation(async () => ({
      id: "dtok_1",
      connectionId: "conn_github_1",
      accessToken: "ghu_stale_token",
      refreshToken: "ghr_refresh_123",
      scope: "repo",
      expiresAt: pastExpiry,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      clientId: "Iv1.test_client",
      clientSecret: "test_secret",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
    }));
    mockRefreshAccessToken.mockImplementation(async () => ({
      success: true,
      accessToken: "ghu_refreshed_token",
      refreshToken: "ghr_refresh_456",
      expiresIn: 3600,
      scope: "repo",
    }));

    const virtualMcp = makeVirtualMcp("org_1", BASE_METADATA);
    const ctx = makeCtx({ virtualMcp });

    await SANDBOX_START.handler(
      { virtualMcpId: "vmcp_1", branch: BRANCH },
      ctx,
    );

    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(1);
    expect(mockTokenUpsert).toHaveBeenCalledTimes(1);
    const upsertArg = (mockTokenUpsert.mock.calls as unknown[][])[0]![0] as {
      accessToken: string;
    };
    expect(upsertArg.accessToken).toBe("ghu_refreshed_token");

    const [, opts] = mockEnsure.mock.calls[0]! as [SandboxId, EnsureOptions];
    expect(opts.repo?.cloneUrl).toContain("ghu_refreshed_token");
    expect(opts.repo?.cloneUrl).not.toContain("ghu_stale_token");
  });

  it("provisions a new desktop VM when user-desktop is explicit even when an agent-sandbox entry exists", async () => {
    // With kind-in-key, different kinds coexist — no teardown occurs.
    const agentSandboxEntry: SandboxRecord = {
      sandboxHandle: "vm_agent-sandbox_existing",
      previewUrl: "https://agent-sandbox.preview/",
      sandboxProviderKind: "agent-sandbox",
    };
    const metadata: Metadata = {
      ...BASE_METADATA,
      // 3-level: agent-sandbox entry lives under its own key
      sandboxMap: {
        [USER_ID]: {
          [BRANCH]: { "agent-sandbox": agentSandboxEntry },
        },
      },
    };
    const virtualMcp = makeVirtualMcp(ORG_ID, metadata);
    const ctx = makeCtx({ virtualMcp });

    // Explicit user-desktop override wins over the recorded hosted entry.
    const result = await SANDBOX_START.handler(
      {
        virtualMcpId: VMCP_ID,
        branch: BRANCH,
        sandboxProviderKind: "user-desktop",
      },
      ctx,
    );

    // No teardown of the agent-sandbox entry (kinds are siblings)
    expect(mockClusterDelete).not.toHaveBeenCalled();
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(result.sandboxProviderKind).toBe("user-desktop");
    expect(result.isNewVm).toBe(true);
  });

  it("SANDBOX_START with no sandboxProviderKind honors an existing recorded kind", async () => {
    const agentSandboxEntry: SandboxRecord = {
      sandboxHandle: "vm_agent-sandbox_existing",
      previewUrl: "https://agent-sandbox.preview/",
      sandboxProviderKind: "agent-sandbox",
      createdAt: 123,
    };
    mockEnsure.mockImplementation(async () => ({
      handle: agentSandboxEntry.sandboxHandle,
      workdir: "/app",
      previewUrl: agentSandboxEntry.previewUrl,
    }));
    const metadata: Metadata = {
      ...BASE_METADATA,
      sandboxMap: {
        [USER_ID]: {
          [BRANCH]: { "agent-sandbox": agentSandboxEntry },
        },
      },
    };
    const virtualMcp = makeVirtualMcp(ORG_ID, metadata);
    const updateSpy = mock(async () => {});
    const ctx = makeCtx({ virtualMcp, updateSpy });

    const result = await SANDBOX_START.handler(
      { virtualMcpId: VMCP_ID, branch: BRANCH },
      ctx,
    );

    expect(result.sandboxProviderKind).toBe("agent-sandbox");
    expect(result.isNewVm).toBe(false);
    expect(mockDesktopDelete).not.toHaveBeenCalled();
    const sandboxMapCall = (updateSpy.mock.calls as unknown[][]).find(
      (call) => {
        const meta = (call[2] as { metadata?: { sandboxMap?: SandboxMap } })
          .metadata;
        return meta?.sandboxMap?.[USER_ID]?.[BRANCH] !== undefined;
      },
    );
    expect(sandboxMapCall).toBeDefined();
    const updated = (
      sandboxMapCall![2] as { metadata: { sandboxMap: SandboxMap } }
    ).metadata;
    const branchMap = updated.sandboxMap[USER_ID]?.[BRANCH] as
      | Record<string, unknown>
      | undefined;
    expect(branchMap?.["agent-sandbox"]).toMatchObject({
      sandboxHandle: agentSandboxEntry.sandboxHandle,
      sandboxProviderKind: "agent-sandbox",
    });
    expect(branchMap?.["user-desktop"]).toBeUndefined();
  });

  it("does not tear down anything when the existing entry is on the same runner", async () => {
    const sameRunnerEntry: SandboxRecord = {
      sandboxHandle: "vm_agent-sandbox_existing",
      previewUrl: "https://agent-sandbox.preview/",
      sandboxProviderKind: "agent-sandbox",
    };
    const metadata: Metadata = {
      ...BASE_METADATA,
      sandboxMap: {
        [USER_ID]: {
          [BRANCH]: { "agent-sandbox": sameRunnerEntry },
        },
      },
    };
    const virtualMcp = makeVirtualMcp(ORG_ID, metadata);
    const ctx = makeCtx({ virtualMcp });

    await SANDBOX_START.handler({ virtualMcpId: VMCP_ID, branch: BRANCH }, ctx);

    expect(mockAgentSandboxDelete).not.toHaveBeenCalled();
    expect(mockClusterDelete).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // sandboxProviderKind default-resolution tests
  // -----------------------------------------------------------------------

  it("SANDBOX_START with no sandboxProviderKind picks the env kind (default policy is env-only)", async () => {
    // Optimistic presence: the default no longer consults link liveness.
    // STUDIO_SANDBOX_PROVIDER is "agent-sandbox" at module load time (top of
    // file), so a fresh (user, branch) with no recorded kind resolves to it.
    const virtualMcp = makeVirtualMcp(ORG_ID, BASE_METADATA);
    const updateSpy = mock(async () => {});
    const ctx = makeCtx({ virtualMcp, updateSpy });

    const result = await SANDBOX_START.handler(
      { virtualMcpId: VMCP_ID, branch: BRANCH },
      ctx,
    );

    expect(result.sandboxProviderKind).toBe("agent-sandbox");
    const updateCall = (updateSpy.mock.calls as unknown[][])[0]!;
    const updated = (updateCall[2] as { metadata: { sandboxMap: SandboxMap } })
      .metadata;
    // 3-level key: sandboxMap[userId][branch][kind]
    const stored = (
      updated.sandboxMap[USER_ID]?.[BRANCH] as Record<string, unknown>
    )?.["agent-sandbox"] as SandboxRecord | undefined;
    expect(stored?.sandboxProviderKind).toBe("agent-sandbox");
  });

  it("SANDBOX_START with explicit sandboxProviderKind ignores defaults", async () => {
    const virtualMcp = makeVirtualMcp(ORG_ID, BASE_METADATA);
    const updateSpy = mock(async () => {});
    const ctx = makeCtx({ virtualMcp, updateSpy });

    const result = await SANDBOX_START.handler(
      {
        virtualMcpId: VMCP_ID,
        branch: BRANCH,
        sandboxProviderKind: "agent-sandbox",
      },
      ctx,
    );

    expect(result.sandboxProviderKind).toBe("agent-sandbox");
    const updateCall = (updateSpy.mock.calls as unknown[][])[0]!;
    const updated = (updateCall[2] as { metadata: { sandboxMap: SandboxMap } })
      .metadata;
    // 3-level key: sandboxMap[userId][branch][kind]
    const stored = (
      updated.sandboxMap[USER_ID]?.[BRANCH] as Record<string, unknown>
    )?.["agent-sandbox"] as SandboxRecord | undefined;
    expect(stored?.sandboxProviderKind).toBe("agent-sandbox");
  });

  it("normalizes legacy cluster input to agent-sandbox", async () => {
    const virtualMcp = makeVirtualMcp(ORG_ID, BASE_METADATA);
    const updateSpy = mock(async () => {});
    const ctx = makeCtx({ virtualMcp, updateSpy });

    const result = await SANDBOX_START.handler(
      {
        virtualMcpId: VMCP_ID,
        branch: BRANCH,
        sandboxProviderKind: "cluster",
      } as unknown as Parameters<typeof SANDBOX_START.handler>[0],
      ctx,
    );

    expect(result.sandboxProviderKind).toBe("agent-sandbox");
    const updateCall = (updateSpy.mock.calls as unknown[][])[0]!;
    const updated = (updateCall[2] as { metadata: { sandboxMap: SandboxMap } })
      .metadata;
    const stored = (
      updated.sandboxMap[USER_ID]?.[BRANCH] as Record<string, unknown>
    )?.["agent-sandbox"] as SandboxRecord | undefined;
    expect(stored?.sandboxProviderKind).toBe("agent-sandbox");
  });

  it("throws RECONNECT_ERROR when refreshing an expired token fails", async () => {
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    mockTokenGet.mockImplementation(async () => ({
      id: "dtok_1",
      connectionId: "conn_github_1",
      accessToken: "ghu_stale_token",
      refreshToken: "ghr_refresh_123",
      scope: "repo",
      expiresAt: pastExpiry,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      clientId: "Iv1.test_client",
      clientSecret: "test_secret",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
    }));
    mockRefreshAccessToken.mockImplementation(async () => ({
      success: false,
      permanent: true,
      status: 400,
      errorCode: "invalid_grant",
      error: "refresh token revoked",
    }));

    const virtualMcp = makeVirtualMcp("org_1", BASE_METADATA);
    const ctx = makeCtx({ virtualMcp });

    await expect(
      SANDBOX_START.handler({ virtualMcpId: "vmcp_1", branch: BRANCH }, ctx),
    ).rejects.toThrow(
      "GitHub token refresh failed — reconnect the mcp-github integration.",
    );
    expect(mockTokenDelete).toHaveBeenCalledWith("conn_github_1");
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});
