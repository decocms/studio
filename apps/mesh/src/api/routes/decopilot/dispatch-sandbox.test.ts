/**
 * Unit test for the helper that the remote-cli dispatch branch uses to
 * resolve which sandbox URL to talk to. The helper unifies with
 * `ensureSandbox` so claude-code/codex runs share the SANDBOX_START sandbox
 * instead of provisioning a per-run empty workdir.
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
}));

const ensureSandboxCalls: Array<{
  virtualMcpId: string;
  branch: string;
  sandboxProviderKind: string;
}> = [];

const nextEnsureSandboxReturn: { previewUrl: string | null } = {
  previewUrl: "http://sleek-flint-0000000000000000.localhost:5174",
};

const { resolveRemoteCliSandboxUrl } = await import("./dispatch-run");

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
