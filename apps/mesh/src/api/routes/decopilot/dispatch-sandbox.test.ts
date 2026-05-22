/**
 * Unit test for the helper that the remote-cli dispatch branch uses to
 * resolve which sandbox URL to talk to. The helper unifies with
 * `ensureVm` so claude-code/codex runs share the VM_START sandbox
 * instead of provisioning a per-run empty workdir.
 */
import { describe, expect, it, mock } from "bun:test";

// `ensureVm` lives in tools/vm/start; we mock the module so the test
// doesn't need to wire up storage, link registry, or the sandbox
// provider. The route file imports `ensureVm` from this path.
//
// `nextEnsureVmReturn` lets individual tests override the previewUrl
// (e.g. force `null` to exercise the helper's defensive throw).
mock.module("@/tools/vm/start", () => ({
  ensureVm: async (input: {
    virtualMcpId: string;
    branch: string;
    sandboxProviderKind: "desktop";
  }) => {
    ensureVmCalls.push(input);
    return {
      vmId: "sleek-flint-0000000000000000",
      previewUrl: nextEnsureVmReturn.previewUrl,
      sandboxUrl: nextEnsureVmReturn.previewUrl,
      sandboxProviderKind: "desktop" as const,
      createdAt: 0,
      startedWith: { packageManager: null, port: null, path: null },
    };
  },
}));

const ensureVmCalls: Array<{
  virtualMcpId: string;
  branch: string;
  sandboxProviderKind: string;
}> = [];

const nextEnsureVmReturn: { previewUrl: string | null } = {
  previewUrl: "https://sleek-flint-0000000000000000.deco.host",
};

const { resolveRemoteCliSandboxUrl } = await import("./dispatch-run");

describe("resolveRemoteCliSandboxUrl", () => {
  it("calls ensureVm with the agent id, branch, and desktop kind", async () => {
    ensureVmCalls.length = 0;
    const sandboxUrl = await resolveRemoteCliSandboxUrl(
      { agent: { id: "vm-1" }, branch: "deco/sleek-flint" },
      // The helper passes ctx straight to ensureVm; the mock ignores it.
      {} as never,
    );
    expect(ensureVmCalls).toEqual([
      {
        virtualMcpId: "vm-1",
        branch: "deco/sleek-flint",
        sandboxProviderKind: "desktop",
      },
    ]);
    expect(sandboxUrl).toBe("https://sleek-flint-0000000000000000.deco.host");
  });

  it("falls back to 'ephemeral' when branch is missing", async () => {
    ensureVmCalls.length = 0;
    await resolveRemoteCliSandboxUrl(
      { agent: { id: "vm-2" }, branch: null },
      {} as never,
    );
    expect(ensureVmCalls[0]?.branch).toBe("ephemeral");
  });

  it("falls back to 'ephemeral' when branch is undefined", async () => {
    ensureVmCalls.length = 0;
    await resolveRemoteCliSandboxUrl({ agent: { id: "vm-3" } }, {} as never);
    expect(ensureVmCalls[0]?.branch).toBe("ephemeral");
  });

  it("throws when ensureVm returns a null previewUrl", async () => {
    ensureVmCalls.length = 0;
    const originalPreviewUrl = nextEnsureVmReturn.previewUrl;
    nextEnsureVmReturn.previewUrl = null;
    try {
      await expect(
        resolveRemoteCliSandboxUrl(
          { agent: { id: "vm-4" }, branch: "deco/test" },
          {} as never,
        ),
      ).rejects.toThrow(/vm-4/);
    } finally {
      nextEnsureVmReturn.previewUrl = originalPreviewUrl;
    }
  });
});
