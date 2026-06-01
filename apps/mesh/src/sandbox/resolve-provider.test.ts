import { describe, expect, mock, test } from "bun:test";
import type {
  EnsureOptions,
  Sandbox,
  SandboxId,
  SandboxProvider,
} from "@decocms/sandbox/provider";

import type { MeshContext } from "../core/mesh-context";
import type {
  LinkClaim,
  LinkClaimRegistry,
} from "../links/link-claim-registry";

// Pin env kind so resolver fallback is deterministic.
process.env.STUDIO_SANDBOX_PROVIDER = "cluster";

async function* readyOnly() {
  yield { kind: "ready" as const };
}

const stubCluster: SandboxProvider = {
  kind: "cluster",
  ensure: async (_id: SandboxId, _opts?: EnsureOptions): Promise<Sandbox> => ({
    handle: "h",
    workdir: "/",
    previewUrl: "https://stub",
  }),
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
  delete: async () => {},
  alive: async () => true,
  getPreviewUrl: async () => null,
  proxyDaemonRequest: async () => new Response(null, { status: 204 }),
  watchClaimLifecycle: () => readyOnly(),
};

const stubDesktop: SandboxProvider = { ...stubCluster, kind: "user-desktop" };

// Mock lifecycle: dispatch on requested kind so we can assert which one was
// picked.
const byKindSpy = mock(
  async (_ctx: unknown, kind: "cluster" | "user-desktop") => {
    if (kind === "cluster") return stubCluster;
    throw new Error("unreachable — resolver builds user-desktop directly");
  },
);
const buildDesktopSpy = mock(async (_ctx: unknown) => stubDesktop);

mock.module("./lifecycle", () => ({
  getSandboxProviderByKind: byKindSpy,
  buildDesktopProvider: buildDesktopSpy,
}));

// Now import the resolver — its lifecycle import has been mocked.
const { resolveSandboxProvider } = await import("./resolve-provider");

function makeLink(): LinkClaim {
  return {
    podId: "pod_1",
    machineId: "m1",
    cliVersion: "1.0.0",
    previewPort: 5174,
    connectedAt: Date.now(),
    capabilities: ["claude-code"],
  } as LinkClaim;
}

function stubCtx(
  link: LinkClaim | null,
  hints?: {
    sandboxPreference?: "cluster-default" | "user-desktop";
    linkForCurrentRun?: LinkClaim;
  },
): MeshContext {
  const registry: LinkClaimRegistry = {
    get: async () => link,
  } as unknown as LinkClaimRegistry;
  return {
    linkClaimRegistry: registry,
    db: {} as never,
    sandboxPreference: hints?.sandboxPreference,
    linkForCurrentRun: hints?.linkForCurrentRun,
  } as unknown as MeshContext;
}

describe("resolveSandboxProvider", () => {
  test("recorded sandboxMap kind wins over the link-or-env default", async () => {
    // User has a link online, so the default policy would pick `user-desktop`.
    // But sandboxMap records `cluster` for (user, branch) — we must honor
    // that recorded kind so the SSE/proxy paths reach the right provider.
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
    const { provider, kind } = await resolveSandboxProvider(
      stubCtx(makeLink()),
      {
        userId: "u-1",
        branch: "deco/foo",
        virtualMcpMetadata: metadata,
      },
    );
    expect(kind).toBe("cluster");
    expect(provider).toBe(stubCluster);
    expect(buildDesktopSpy).not.toHaveBeenCalled();
  });

  test("link online + no sandboxMap entry → user-desktop, bound to link", async () => {
    const link = makeLink();
    const { provider, kind } = await resolveSandboxProvider(stubCtx(link), {
      userId: "u-1",
      branch: "deco/new",
      virtualMcpMetadata: null,
    });
    expect(kind).toBe("user-desktop");
    expect(provider).toBe(stubDesktop);
    expect(buildDesktopSpy).toHaveBeenCalled();
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
    const { kind } = await resolveSandboxProvider(stubCtx(makeLink()), {
      userId: "u-1",
      branch: "deco/foo",
      virtualMcpMetadata: metadata,
      explicitKind: "cluster",
    });
    expect(kind).toBe("cluster");
  });

  test("no link + no sandboxMap entry → env kind (cluster here)", async () => {
    const { kind } = await resolveSandboxProvider(stubCtx(null), {
      userId: "u-1",
      branch: "deco/fresh",
      virtualMcpMetadata: null,
    });
    expect(kind).toBe("cluster");
  });

  test("ctx hint (sandboxPreference=user-desktop + link) short-circuits without sandboxMap read", async () => {
    // dispatch-run sets these ctx fields from the resolved DispatchTarget.
    // Resolver must honor them and skip the sandboxMap lookup so the decopilot
    // hot path doesn't pay a DB hit per turn. Metadata is intentionally
    // present and would point at a *different* recorded kind — proving
    // the hint wins.
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
    const link = makeLink();
    const ctx = stubCtx(null, {
      sandboxPreference: "user-desktop",
      linkForCurrentRun: link,
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
    const ctx = stubCtx(makeLink(), { sandboxPreference: "cluster-default" });
    const { kind } = await resolveSandboxProvider(ctx, {
      userId: "u-1",
      branch: "deco/foo",
      virtualMcpMetadata: null,
    });
    // STUDIO_SANDBOX_PROVIDER=cluster pinned at top of file.
    expect(kind).toBe("cluster");
  });

  test("sandboxPreference=cluster-default + env=user-desktop + link online → binds user-desktop with link", async () => {
    // Regression: background fires (cron/webhook/event automations) get
    // `sandboxPreference: "cluster-default"` from dispatch-run, but in local
    // dev env defaults to `user-desktop`. Before the fix this hit
    // `instantiate("user-desktop")` directly and threw the confusing
    // "user-desktop runner cannot be instantiated without a per-run link claim".
    const prev = process.env.STUDIO_SANDBOX_PROVIDER;
    process.env.STUDIO_SANDBOX_PROVIDER = "user-desktop";
    try {
      const link = makeLink();
      const ctx = stubCtx(link, { sandboxPreference: "cluster-default" });
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

  test("sandboxPreference=cluster-default + env=user-desktop + no link → clear error", async () => {
    const prev = process.env.STUDIO_SANDBOX_PROVIDER;
    process.env.STUDIO_SANDBOX_PROVIDER = "user-desktop";
    try {
      const ctx = stubCtx(null, { sandboxPreference: "cluster-default" });
      await expect(
        resolveSandboxProvider(ctx, {
          userId: "u-1",
          branch: "deco/foo",
          virtualMcpMetadata: null,
        }),
      ).rejects.toThrow(/No link daemon registered/);
    } finally {
      process.env.STUDIO_SANDBOX_PROVIDER = prev;
    }
  });

  test("user-desktop resolution throws when link daemon is offline", async () => {
    // sandboxMap records `user-desktop` but link is gone — caller (events/proxy
    // middleware) catches this and surfaces a failed phase / 503.
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
    await expect(
      resolveSandboxProvider(stubCtx(null), {
        userId: "u-1",
        branch: "deco/foo",
        virtualMcpMetadata: metadata,
      }),
    ).rejects.toThrow(/No link daemon registered/);
  });
});
