import { describe, expect, mock, test } from "bun:test";
import type {
  EnsureOptions,
  Sandbox,
  SandboxId,
  SandboxProvider,
  SandboxProviderKind,
} from "@decocms/sandbox/provider";

import type { StudioContext } from "../core/studio-context";

// Pin env kind so resolver fallback is deterministic.
process.env.STUDIO_SANDBOX_PROVIDER = "agent-sandbox";

async function* readyOnly() {
  yield { kind: "ready" as const };
}

const stubAgentSandbox: SandboxProvider = {
  kind: "agent-sandbox",
  ensure: async (_id: SandboxId, _opts?: EnsureOptions): Promise<Sandbox> => ({
    handle: "h",
    workdir: "/",
    previewUrl: "https://stub",
  }),
  delete: async () => {},
  alive: async () => true,
  getPreviewUrl: async () => null,
  proxyDaemonRequest: async () => new Response(null, { status: 204 }),
  watchClaimLifecycle: () => readyOnly(),
};

const realLifecycle = await import("./lifecycle");

// Mock lifecycle: dispatch on requested kind so we can assert which one was
// picked.
const byKindSpy = mock(async (_ctx: unknown, kind: SandboxProviderKind) => {
  if (kind === "agent-sandbox") return stubAgentSandbox;
  throw new Error(`unexpected kind reached lifecycle: ${kind}`);
});

mock.module("./lifecycle", () => ({
  getSandboxProviderByKind: byKindSpy,
  getOrInitSharedRunner: realLifecycle.getOrInitSharedRunner,
  subscribeLifecycle: realLifecycle.subscribeLifecycle,
  __resetSharedLifecyclesForTesting:
    realLifecycle.__resetSharedLifecyclesForTesting,
}));

// Now import the resolver — its lifecycle import has been mocked.
const { resolveSandboxProvider } = await import("./resolve-provider");

function stubCtx(hints?: {
  sandboxPreference?: "agent-sandbox" | "cluster-default" | "user-desktop";
}): StudioContext {
  return {
    db: {} as never,
    sandboxPreference: hints?.sandboxPreference,
  } as unknown as StudioContext;
}

describe("resolveSandboxProvider", () => {
  test("recorded sandboxMap kind wins over the link-or-env default", async () => {
    // User has a link online, so the default policy would pick `user-desktop`.
    // But sandboxMap records legacy `cluster` for (user, branch) — we must
    // normalize and honor that recorded hosted kind so the SSE/proxy paths
    // reach the right provider.
    const metadata = {
      sandboxMap: {
        "u-1": {
          "deco/foo": {
            cluster: {
              sandboxHandle: "vm_xyz",
              previewUrl: "https://p",
              sandboxApiUrl: "https://p",
              sandboxProviderKind: "cluster",
              createdAt: 1,
              startedWith: { packageManager: null, port: null, path: null },
            },
          },
        },
      },
    };
    const { provider, kind } = await resolveSandboxProvider(stubCtx(), {
      userId: "u-1",
      branch: "deco/foo",
      virtualMcpMetadata: metadata,
    });
    expect(kind).toBe("agent-sandbox");
    expect(provider).toBe(stubAgentSandbox);
  });

  test("no sandboxMap entry + no ctx hint → env kind (default policy is env-only)", async () => {
    // Optimistic presence: the default policy no longer consults link liveness.
    // With STUDIO_SANDBOX_PROVIDER pinned to `agent-sandbox`, a fresh (user,
    // branch) with no recorded kind and no per-run `sandboxPreference` hint
    // falls through to the env kind regardless of whether a link is online.
    const { provider, kind } = await resolveSandboxProvider(stubCtx(), {
      userId: "u-1",
      branch: "deco/new",
      virtualMcpMetadata: null,
    });
    expect(kind).toBe("agent-sandbox");
    expect(provider).toBe(stubAgentSandbox);
  });

  test("explicit override beats both sandboxMap and default policy", async () => {
    const metadata = {
      sandboxMap: {
        "u-1": {
          "deco/foo": {
            "user-desktop": {
              sandboxHandle: "vm_xyz",
              previewUrl: "https://p",
              sandboxApiUrl: "https://p",
              sandboxProviderKind: "user-desktop",
              createdAt: 1,
              startedWith: { packageManager: null, port: null, path: null },
            },
          },
        },
      },
    };
    const { kind } = await resolveSandboxProvider(stubCtx(), {
      userId: "u-1",
      branch: "deco/foo",
      virtualMcpMetadata: metadata,
      explicitKind: "agent-sandbox",
    });
    expect(kind).toBe("agent-sandbox");
  });

  test("no link + no sandboxMap entry → env kind (agent-sandbox here)", async () => {
    const { kind } = await resolveSandboxProvider(stubCtx(), {
      userId: "u-1",
      branch: "deco/fresh",
      virtualMcpMetadata: null,
    });
    expect(kind).toBe("agent-sandbox");
  });

  test("ctx hint (sandboxPreference=user-desktop) resolves to the hosted provider", async () => {
    // `user-desktop` is a legacy value with no implementation since the link
    // daemon was removed. It must still resolve — to the hosted provider —
    // rather than throw, and still skip the sandboxMap lookup.
    const metadata = {
      sandboxMap: {
        "u-1": {
          "deco/foo": {
            cluster: {
              sandboxHandle: "vm_xyz",
              previewUrl: "https://p",
              sandboxApiUrl: "https://p",
              sandboxProviderKind: "cluster",
              createdAt: 1,
              startedWith: { packageManager: null, port: null, path: null },
            },
          },
        },
      },
    };
    const ctx = stubCtx({
      sandboxPreference: "user-desktop",
    });
    const { kind, provider } = await resolveSandboxProvider(ctx, {
      userId: "u-1",
      branch: "deco/foo",
      virtualMcpMetadata: metadata,
    });
    expect(kind).toBe("agent-sandbox");
    expect(provider).toBe(stubAgentSandbox);
  });

  test("ctx hint (sandboxPreference=cluster-default) routes to env kind", async () => {
    const ctx = stubCtx({ sandboxPreference: "cluster-default" });
    const { kind } = await resolveSandboxProvider(ctx, {
      userId: "u-1",
      branch: "deco/foo",
      virtualMcpMetadata: null,
    });
    // STUDIO_SANDBOX_PROVIDER=agent-sandbox pinned at top of file.
    expect(kind).toBe("agent-sandbox");
  });

  test("sandboxPreference=cluster-default + env=user-desktop → hosted", async () => {
    // Background fires (cron/webhook/event automations) get
    // `sandboxPreference: "cluster-default"`, and a local dev env may still be
    // pinned to the legacy `user-desktop`. It resolves to hosted rather than
    // throwing on a provider that no longer exists — and reports the hosted
    // kind, so nothing new is persisted under a kind with no runner.
    const prev = process.env.STUDIO_SANDBOX_PROVIDER;
    process.env.STUDIO_SANDBOX_PROVIDER = "user-desktop";
    try {
      const ctx = stubCtx({ sandboxPreference: "cluster-default" });
      const { kind, provider } = await resolveSandboxProvider(ctx, {
        userId: "u-1",
        branch: "deco/foo",
        virtualMcpMetadata: null,
      });
      expect(kind).toBe("agent-sandbox");
      expect(provider).toBe(stubAgentSandbox);
    } finally {
      process.env.STUDIO_SANDBOX_PROVIDER = prev;
    }
  });

  test("sandboxPreference=agent-sandbox + env=user-desktop still binds hosted provider", async () => {
    const prev = process.env.STUDIO_SANDBOX_PROVIDER;
    process.env.STUDIO_SANDBOX_PROVIDER = "user-desktop";
    try {
      const ctx = stubCtx({ sandboxPreference: "agent-sandbox" });
      const { kind, provider } = await resolveSandboxProvider(ctx, {
        userId: "u-1",
        branch: "deco/foo",
        virtualMcpMetadata: null,
      });
      expect(kind).toBe("agent-sandbox");
      expect(provider).toBe(stubAgentSandbox);
    } finally {
      process.env.STUDIO_SANDBOX_PROVIDER = prev;
    }
  });

  test("a recorded user-desktop sandboxMap entry still resolves, on hosted", async () => {
    // Old rows persist `user-desktop` (migration 092 normalized `desktop` /
    // `remote-user` into it). Reading one must not throw now that the desktop
    // provider is gone — it is served by hosted AND reported as `agent-sandbox`,
    // so a caller that re-persists this kind writes the runner it actually got.
    const metadata = {
      sandboxMap: {
        "u-1": {
          "deco/foo": {
            "user-desktop": {
              sandboxHandle: "vm_desktop",
              previewUrl: "https://p",
              sandboxApiUrl: "https://p",
              sandboxProviderKind: "user-desktop",
              createdAt: 1,
              startedWith: { packageManager: null, port: null, path: null },
            },
          },
        },
      },
    };
    const ctx = stubCtx({});
    const { kind, provider } = await resolveSandboxProvider(ctx, {
      userId: "u-1",
      branch: "deco/foo",
      virtualMcpMetadata: metadata,
    });
    expect(kind).toBe("agent-sandbox");
    expect(provider).toBe(stubAgentSandbox);
  });
});
