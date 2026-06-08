/**
 * Unit tests for:
 *   - `resolveRemoteCliSandboxUrl` — the ensure-backed preview-URL helper.
 *   - `computeDesktopSandboxHandle` — the pure, I/O-free handle derivation
 *     introduced in C-bis S4 to replace the warm-ensure round-trip at the
 *     two dispatch sites (prepareRun + pullDispatch). The preview-URL site
 *     (`resolveRemoteCliSandboxUrl`) keeps the full ensure path.
 */
import { describe, expect, it, mock } from "bun:test";

// `ensureSandbox` lives in tools/sandbox/start; we mock the module so the
// test doesn't need to wire up storage, link registry, or the sandbox
// provider. The route file imports `ensureSandbox` from this path.
//
// `nextEnsureSandboxReturn` lets individual tests override the previewUrl
// (e.g. force `null` to exercise the helper's defensive throw).
mock.module("@/tools/sandbox/start", () => ({
  ensureSandbox: async (input: {
    virtualMcpId: string;
    branch: string;
    sandboxProviderKind: "user-desktop";
  }) => {
    ensureSandboxCalls.push(input);
    return {
      sandboxHandle: "sleek-flint-0000000000000000",
      previewUrl: nextEnsureSandboxReturn.previewUrl,
      sandboxApiUrl: nextEnsureSandboxReturn.previewUrl,
      sandboxProviderKind: "user-desktop" as const,
      createdAt: 0,
      startedWith: { packageManager: null, port: null, path: null },
    };
  },
  // dispatch-run transitively imports `@/api/app`, which loads
  // `tools/sandbox/index.ts` and re-exports `SANDBOX_START` from "./start".
  // Without this stub the re-export resolves to `undefined` against the
  // mock and Bun throws "export 'SANDBOX_START' not found in './start'".
  SANDBOX_START: { name: "SANDBOX_START" },
}));

const ensureSandboxCalls: Array<{
  virtualMcpId: string;
  branch: string;
  sandboxProviderKind: string;
}> = [];

const nextEnsureSandboxReturn: { previewUrl: string | null } = {
  previewUrl: "http://sleek-flint-0000000000000000.localhost:5174",
};

const {
  resolveRemoteCliSandboxUrl,
  computeDesktopSandboxHandle,
  ensurePushDispatchSandboxHandle,
} = await import("./dispatch-run");

describe("resolveRemoteCliSandboxUrl", () => {
  it("calls ensureSandbox with the agent id, branch, and user-desktop kind", async () => {
    ensureSandboxCalls.length = 0;
    const sandboxApiUrl = await resolveRemoteCliSandboxUrl(
      { agent: { id: "vm-1" }, branch: "deco/sleek-flint" },
      // The helper passes ctx straight to ensureSandbox; the mock ignores it.
      {} as never,
    );
    expect(ensureSandboxCalls).toEqual([
      {
        virtualMcpId: "vm-1",
        branch: "deco/sleek-flint",
        sandboxProviderKind: "user-desktop",
      },
    ]);
    expect(sandboxApiUrl).toBe(
      "http://sleek-flint-0000000000000000.localhost:5174",
    );
  });

  it("falls back to 'ephemeral' when branch is missing", async () => {
    ensureSandboxCalls.length = 0;
    await resolveRemoteCliSandboxUrl(
      { agent: { id: "vm-2" }, branch: null },
      {} as never,
    );
    expect(ensureSandboxCalls[0]?.branch).toBe("ephemeral");
  });

  it("falls back to 'ephemeral' when branch is undefined", async () => {
    ensureSandboxCalls.length = 0;
    await resolveRemoteCliSandboxUrl({ agent: { id: "vm-3" } }, {} as never);
    expect(ensureSandboxCalls[0]?.branch).toBe("ephemeral");
  });

  it("throws when ensureSandbox returns a null previewUrl", async () => {
    ensureSandboxCalls.length = 0;
    const originalPreviewUrl = nextEnsureSandboxReturn.previewUrl;
    nextEnsureSandboxReturn.previewUrl = null;
    try {
      await expect(
        resolveRemoteCliSandboxUrl(
          { agent: { id: "vm-4" }, branch: "deco/test" },
          {} as never,
        ),
      ).rejects.toThrow(/vm-4/);
    } finally {
      nextEnsureSandboxReturn.previewUrl = originalPreviewUrl;
    }
  });
});

describe("computeDesktopSandboxHandle", () => {
  const BASE = {
    agentId: "vmcp_abc",
    userId: "user_xyz",
    organizationId: "org_def",
    branch: "deco/sleek-flint",
  };

  it("returns a non-empty string", () => {
    const handle = computeDesktopSandboxHandle(BASE);
    expect(typeof handle).toBe("string");
    expect(handle.length).toBeGreaterThan(0);
  });

  it("is deterministic — same inputs produce the same handle", () => {
    expect(computeDesktopSandboxHandle(BASE)).toBe(
      computeDesktopSandboxHandle({ ...BASE }),
    );
  });

  it("produces a <slug>-<16-char hash> shape (matches computeClaimHandle contract)", () => {
    const handle = computeDesktopSandboxHandle(BASE);
    // computeHandle: slugifyBranch(branch) + "-" + hashSandboxId(id, 16)
    const hash = handle.split("-").pop()!;
    expect(hash.length).toBe(16);
  });

  it("differs when agentId changes", () => {
    expect(
      computeDesktopSandboxHandle({ ...BASE, agentId: "vmcp_other" }),
    ).not.toBe(computeDesktopSandboxHandle(BASE));
  });

  it("differs when userId changes", () => {
    expect(
      computeDesktopSandboxHandle({ ...BASE, userId: "user_other" }),
    ).not.toBe(computeDesktopSandboxHandle(BASE));
  });

  it("differs when branch changes", () => {
    expect(
      computeDesktopSandboxHandle({ ...BASE, branch: "deco/other-branch" }),
    ).not.toBe(computeDesktopSandboxHandle(BASE));
  });

  it("produces a handle with the branch slug as a prefix for named branches", () => {
    // The branch slug is the last path segment after slugification.
    // "deco/sleek-flint" → last segment "sleek-flint" → slug prefix in handle.
    const handle = computeDesktopSandboxHandle(BASE);
    expect(handle).toMatch(/sleek-flint/);
  });
});

describe("ensurePushDispatchSandboxHandle", () => {
  it("ENSURES (spawns) the sandbox — the push path has no daemon self-ensure backstop", async () => {
    ensureSandboxCalls.length = 0;
    const handle = await ensurePushDispatchSandboxHandle(
      { id: "vm-1" },
      "deco/sleek-flint", // thread branch
      null, // input branch
      {} as never,
    );
    // It MUST run the full ensure (not a pure handle derivation).
    expect(ensureSandboxCalls).toEqual([
      {
        virtualMcpId: "vm-1",
        branch: "deco/sleek-flint",
        sandboxProviderKind: "user-desktop",
      },
    ]);
    // It returns the handle ensureSandbox actually provisioned, so the
    // dispatched handle can never drift from the spawned one.
    expect(handle).toBe("sleek-flint-0000000000000000");
  });

  it("prefers the thread branch over the request branch (handle-drift fix)", async () => {
    ensureSandboxCalls.length = 0;
    await ensurePushDispatchSandboxHandle(
      { id: "vm-2" },
      "deco/pinned",
      "deco/from-request",
      {} as never,
    );
    expect(ensureSandboxCalls[0]?.branch).toBe("deco/pinned");
  });

  it("falls back to the request branch when the thread has none", async () => {
    ensureSandboxCalls.length = 0;
    await ensurePushDispatchSandboxHandle(
      { id: "vm-3" },
      null,
      "deco/from-request",
      {} as never,
    );
    expect(ensureSandboxCalls[0]?.branch).toBe("deco/from-request");
  });

  it("falls back to 'ephemeral' when neither branch is set", async () => {
    ensureSandboxCalls.length = 0;
    await ensurePushDispatchSandboxHandle(
      { id: "vm-4" },
      null,
      null,
      {} as never,
    );
    expect(ensureSandboxCalls[0]?.branch).toBe("ephemeral");
  });
});
