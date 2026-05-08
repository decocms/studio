import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { VmMap, VmMapEntry } from "@decocms/mesh-sdk";
import type { MeshContext } from "../../core/mesh-context";
import type { SandboxRunner } from "@decocms/sandbox/runner";

// Mock per-kind runner lookup BEFORE importing VM_DELETE.
const mockDelete = mock(async (_handle: string): Promise<void> => {});
const lastRequestedKind: { value: string | null } = { value: null };

async function* readyOnly() {
  yield { kind: "ready" as const };
}

function makeMockRunner(kind: "docker" | "freestyle"): SandboxRunner {
  return {
    kind,
    ensure: async () => ({
      handle: "_unused",
      workdir: "/app",
      previewUrl: null,
    }),
    exec: async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }),
    delete: (h) => mockDelete(h),
    alive: async () => true,
    getPreviewUrl: async () => null,
    proxyDaemonRequest: async () => new Response(null, { status: 204 }),
    watchClaimLifecycle: () => readyOnly(),
  };
}

mock.module("../../sandbox/lifecycle", () => ({
  getSharedRunner: () => makeMockRunner("freestyle"),
  getRunnerByKind: (_ctx: unknown, kind: "docker" | "freestyle") => {
    lastRequestedKind.value = kind;
    return makeMockRunner(kind);
  },
  getSharedRunnerIfInit: () => null,
  asDockerRunner: () => null,
}));

const { VM_DELETE } = await import("./stop");

const BRANCH = "feat/example";

const FREESTYLE_ENTRY: VmMapEntry = {
  vmId: "vm_existing",
  previewUrl: "https://vmcp-1.deco.studio",
  runnerKind: "freestyle",
};

const DOCKER_ENTRY: VmMapEntry = {
  vmId: "f9e2fadeb813e08eb00eef6f962be2b2",
  previewUrl: "http://f9e2.localhost:7070/",
  runnerKind: "docker",
};

const LEGACY_ENTRY: VmMapEntry = {
  vmId: "vm_legacy",
  previewUrl: "https://legacy.deco.studio",
  // no runnerKind — legacy entry, expected to default to freestyle
};

type Metadata = { vmMap?: VmMap };

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
}): MeshContext {
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
    baseUrl: "https://mesh.example.com",
    metadata: { requestId: "req_1", timestamp: new Date() },
    eventBus: null as never,
    objectStorage: null as never,
    aiProviders: null as never,
    createMCPProxy: null as never,
    getOrCreateClient: null as never,
    pendingRevalidations: [],
    monitoring: null as never,
  } as unknown as MeshContext;
}

describe("VM_DELETE", () => {
  beforeEach(() => {
    mockDelete.mockReset();
    mockDelete.mockImplementation(async () => {});
    lastRequestedKind.value = null;
  });

  it("calls runner.delete with the entry's handle and removes vmMap entry", async () => {
    const metadata: Metadata = {
      vmMap: { "user-1": { [BRANCH]: FREESTYLE_ENTRY } },
    };
    const virtualMcp = makeVirtualMcp("org_1", metadata);
    const updateSpy = mock(async () => {});
    const ctx = makeCtx({ virtualMcp, updateSpy });

    const result = await VM_DELETE.handler(
      { virtualMcpId: "vmcp_1", branch: BRANCH },
      ctx,
    );

    expect(result).toEqual({ success: true });
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith(FREESTYLE_ENTRY.vmId);
    expect(lastRequestedKind.value).toBe("freestyle");

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const updateCall = (updateSpy.mock.calls as unknown[][])[0]!;
    const updated = (updateCall[2] as { metadata: { vmMap: VmMap } }).metadata;
    expect(updated.vmMap["user-1"]).toBeUndefined();
  });

  it("dispatches to the docker runner when entry.runnerKind is 'docker'", async () => {
    const metadata: Metadata = {
      vmMap: { "user-1": { [BRANCH]: DOCKER_ENTRY } },
    };
    const virtualMcp = makeVirtualMcp("org_1", metadata);
    const ctx = makeCtx({ virtualMcp });

    await VM_DELETE.handler({ virtualMcpId: "vmcp_1", branch: BRANCH }, ctx);

    expect(mockDelete).toHaveBeenCalledWith(DOCKER_ENTRY.vmId);
    expect(lastRequestedKind.value).toBe("docker");
  });

  it("defaults to freestyle when entry has no runnerKind (legacy entries)", async () => {
    const metadata: Metadata = {
      vmMap: { "user-1": { [BRANCH]: LEGACY_ENTRY } },
    };
    const virtualMcp = makeVirtualMcp("org_1", metadata);
    const ctx = makeCtx({ virtualMcp });

    await VM_DELETE.handler({ virtualMcpId: "vmcp_1", branch: BRANCH }, ctx);

    expect(mockDelete).toHaveBeenCalledWith(LEGACY_ENTRY.vmId);
    expect(lastRequestedKind.value).toBe("freestyle");
  });

  // Regression guard for the invariant called out in stop.ts:1–5: a pod that
  // flipped STUDIO_SANDBOX_RUNNER between start and stop must still tear down
  // the runner that the entry was created against.
  it("dispatches on the entry's runnerKind even when STUDIO_SANDBOX_RUNNER env disagrees", async () => {
    const original = process.env.STUDIO_SANDBOX_RUNNER;
    process.env.STUDIO_SANDBOX_RUNNER = "freestyle";
    try {
      const metadata: Metadata = {
        vmMap: { "user-1": { [BRANCH]: DOCKER_ENTRY } },
      };
      const virtualMcp = makeVirtualMcp("org_1", metadata);
      const ctx = makeCtx({ virtualMcp });

      await VM_DELETE.handler({ virtualMcpId: "vmcp_1", branch: BRANCH }, ctx);

      expect(mockDelete).toHaveBeenCalledWith(DOCKER_ENTRY.vmId);
      expect(lastRequestedKind.value).toBe("docker");
    } finally {
      if (original === undefined) delete process.env.STUDIO_SANDBOX_RUNNER;
      else process.env.STUDIO_SANDBOX_RUNNER = original;
    }
  });

  it("skips runner.delete and DB update when no vmMap entry for (user, branch)", async () => {
    const metadata: Metadata = {
      vmMap: { "other-user": { [BRANCH]: FREESTYLE_ENTRY } },
    };
    const virtualMcp = makeVirtualMcp("org_1", metadata);
    const updateSpy = mock(async () => {});
    const ctx = makeCtx({ virtualMcp, updateSpy });

    const result = await VM_DELETE.handler(
      { virtualMcpId: "vmcp_1", branch: BRANCH },
      ctx,
    );

    expect(result).toEqual({ success: true });
    expect(mockDelete).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("returns success when virtualMcp not found (null from findById)", async () => {
    const ctx = makeCtx({ virtualMcp: null });

    const result = await VM_DELETE.handler(
      { virtualMcpId: "vmcp_missing", branch: BRANCH },
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
      VM_DELETE.handler({ virtualMcpId: "vmcp_1", branch: BRANCH }, ctx),
    ).rejects.toThrow("User ID required");
  });
});
