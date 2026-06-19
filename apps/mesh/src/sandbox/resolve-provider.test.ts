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

const stubDesktop: SandboxProvider = {
  ...stubAgentSandbox,
  kind: "user-desktop",
};

const realLifecycle = await import("./lifecycle");

// Mock lifecycle: dispatch on requested kind so we can assert which one was
// picked.
const byKindSpy = mock(async (_ctx: unknown, kind: SandboxProviderKind) => {
  if (kind === "agent-sandbox") return stubAgentSandbox;
  throw new Error("unreachable — resolver builds user-desktop directly");
});
const buildDesktopSpy = mock(async (_ctx: unknown) => stubDesktop);

mock.module("./lifecycle", () => ({
  getSandboxProviderByKind: byKindSpy,
  buildDesktopProvider: buildDesktopSpy,
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
    expect(buildDesktopSpy).not.toHaveBeenCalled();
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
    expect(buildDesktopSpy).not.toHaveBeenCalled();
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

  test("ctx hint (sandboxPreference=user-desktop) short-circuits without sandboxMap read", async () => {
    // dispatch-run sets `sandboxPreference` on ctx from the resolved
    // DispatchTarget. Resolver must honor it and skip the sandboxMap lookup so
    // the decopilot hot path doesn't pay a DB hit per turn. Metadata is
    // intentionally present and would point at a *different* recorded kind —
    // proving the hint wins.
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
    expect(kind).toBe("user-desktop");
    expect(provider).toBe(stubDesktop);
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

  test("sandboxPreference=cluster-default + env=user-desktop → binds user-desktop", async () => {
    // Regression: background fires (cron/webhook/event automations) get
    // `sandboxPreference: "cluster-default"` from dispatch-run, but in local
    // dev env defaults to `user-desktop`. Before the fix this hit
    // `instantiate("user-desktop")` directly and threw the confusing
    // "user-desktop provider cannot be instantiated without a per-run link claim".
    const prev = process.env.STUDIO_SANDBOX_PROVIDER;
    process.env.STUDIO_SANDBOX_PROVIDER = "user-desktop";
    try {
      const ctx = stubCtx({ sandboxPreference: "cluster-default" });
      const { kind, provider } = await resolveSandboxProvider(ctx, {
        userId: "u-1",
        branch: "deco/foo",
        virtualMcpMetadata: null,
      });
      expect(kind).toBe("user-desktop");
      expect(provider).toBe(stubDesktop);
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

  test("sandboxPreference=cluster-default + env=user-desktop + no link → builds desktop optimistically", async () => {
    // Optimistic presence: there is no claim precondition anymore. With env
    // resolving to `user-desktop`, `cluster-default` builds the desktop provider
    // unconditionally — operations fail-fast over the tunnel if no daemon
    // answers, rather than the resolver refusing up front.
    const prev = process.env.STUDIO_SANDBOX_PROVIDER;
    process.env.STUDIO_SANDBOX_PROVIDER = "user-desktop";
    try {
      const ctx = stubCtx({ sandboxPreference: "cluster-default" });
      const { kind, provider } = await resolveSandboxProvider(ctx, {
        userId: "u-1",
        branch: "deco/foo",
        virtualMcpMetadata: null,
      });
      expect(kind).toBe("user-desktop");
      expect(provider).toBe(stubDesktop);
    } finally {
      process.env.STUDIO_SANDBOX_PROVIDER = prev;
    }
  });

  test("recorded user-desktop builds the desktop provider even when offline", async () => {
    // Optimistic presence: a sandboxMap entry recorded as `user-desktop` resolves
    // to the desktop provider regardless of link liveness. There is no pre-flight
    // claim check — the tunnel operation fails-fast later if no daemon answers,
    // and the VM-tool layer reaps + respawns on proxy failure.
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
    const { kind, provider } = await resolveSandboxProvider(stubCtx(), {
      userId: "u-1",
      branch: "deco/foo",
      virtualMcpMetadata: metadata,
    });
    expect(kind).toBe("user-desktop");
    expect(provider).toBe(stubDesktop);
  });
});
