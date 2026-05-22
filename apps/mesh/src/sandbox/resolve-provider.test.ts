import { describe, expect, mock, test } from "bun:test";
import type {
  EnsureOptions,
  Sandbox,
  SandboxId,
  SandboxProvider,
} from "@decocms/sandbox/provider";

import type { MeshContext } from "../core/mesh-context";
import type { LinkEntry } from "../links/protocol";
import type { LinkRegistry } from "../links/link-registry";

// Pin env kind so resolver fallback is deterministic.
process.env.STUDIO_SANDBOX_RUNNER = "docker";

async function* readyOnly() {
  yield { kind: "ready" as const };
}

const stubDocker: SandboxProvider = {
  kind: "docker",
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

const stubAgentSandbox: SandboxProvider = {
  ...stubDocker,
  kind: "agent-sandbox",
};
const stubRemoteUser: SandboxProvider = { ...stubDocker, kind: "remote-user" };

// Mock lifecycle: dispatch on requested kind so we can assert which one was
// picked.
const byKindSpy = mock(
  async (_ctx: unknown, kind: "docker" | "agent-sandbox" | "remote-user") => {
    if (kind === "docker") return stubDocker;
    if (kind === "agent-sandbox") return stubAgentSandbox;
    throw new Error("unreachable — resolver builds remote-user directly");
  },
);
const buildRemoteSpy = mock(async () => stubRemoteUser);

mock.module("./lifecycle", () => ({
  getSandboxProviderByKind: byKindSpy,
  buildRemoteUserProvider: buildRemoteSpy,
}));

// Now import the resolver — its lifecycle import has been mocked.
const { resolveSandboxProvider } = await import("./resolve-provider");

function makeLink(): LinkEntry {
  return {
    tunnelUrl: "https://tunnel.example",
    linkSecret: "secret",
    capabilities: ["claude-code"],
  } as LinkEntry;
}

function stubCtx(
  link: LinkEntry | null,
  hints?: {
    sandboxPreference?: "default" | "remote-user";
    linkForCurrentRun?: LinkEntry;
  },
): MeshContext {
  const registry: LinkRegistry = {
    get: async () => link,
  } as unknown as LinkRegistry;
  return {
    linkRegistry: registry,
    db: {} as never,
    sandboxPreference: hints?.sandboxPreference,
    linkForCurrentRun: hints?.linkForCurrentRun,
  } as unknown as MeshContext;
}

describe("resolveSandboxProvider", () => {
  test("recorded vmMap kind wins over the link-or-env default", async () => {
    // User has a link online, so the default policy would pick `remote-user`.
    // But vmMap records `agent-sandbox` for (user, branch) — we must honor
    // that recorded kind so the SSE/proxy paths reach the right provider.
    const metadata = {
      vmMap: {
        "u-1": {
          "deco/foo": {
            "agent-sandbox": {
              vmId: "vm_xyz",
              previewUrl: "https://p",
              sandboxUrl: "https://p",
              sandboxProviderKind: "agent-sandbox",
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
    expect(kind).toBe("agent-sandbox");
    expect(provider).toBe(stubAgentSandbox);
    expect(buildRemoteSpy).not.toHaveBeenCalled();
  });

  test("link online + no vmMap entry → remote-user, bound to link", async () => {
    const link = makeLink();
    const { provider, kind } = await resolveSandboxProvider(stubCtx(link), {
      userId: "u-1",
      branch: "deco/new",
      virtualMcpMetadata: null,
    });
    expect(kind).toBe("remote-user");
    expect(provider).toBe(stubRemoteUser);
    expect(buildRemoteSpy).toHaveBeenCalled();
  });

  test("explicit override beats both vmMap and default policy", async () => {
    const metadata = {
      vmMap: {
        "u-1": {
          "deco/foo": {
            "remote-user": {
              vmId: "vm_xyz",
              previewUrl: "https://p",
              sandboxUrl: "https://p",
              sandboxProviderKind: "remote-user",
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
      explicitKind: "docker",
    });
    expect(kind).toBe("docker");
  });

  test("no link + no vmMap entry → env kind (docker here)", async () => {
    const { kind } = await resolveSandboxProvider(stubCtx(null), {
      userId: "u-1",
      branch: "deco/fresh",
      virtualMcpMetadata: null,
    });
    expect(kind).toBe("docker");
  });

  test("ctx hint (sandboxPreference=remote-user + link) short-circuits without vmMap read", async () => {
    // dispatch-run sets these ctx fields from the resolved DispatchTarget.
    // Resolver must honor them and skip the vmMap lookup so the decopilot
    // hot path doesn't pay a DB hit per turn. Metadata is intentionally
    // present and would point at a *different* recorded kind — proving
    // the hint wins.
    const metadata = {
      vmMap: {
        "u-1": {
          "deco/foo": {
            "agent-sandbox": {
              vmId: "vm_xyz",
              previewUrl: "https://p",
              sandboxUrl: "https://p",
              sandboxProviderKind: "agent-sandbox",
              createdAt: 1,
              startedWith: { packageManager: null, port: null, path: null },
            },
          },
        },
      },
    };
    const link = makeLink();
    const ctx = stubCtx(null, {
      sandboxPreference: "remote-user",
      linkForCurrentRun: link,
    });
    const { kind, provider } = await resolveSandboxProvider(ctx, {
      userId: "u-1",
      branch: "deco/foo",
      virtualMcpMetadata: metadata,
    });
    expect(kind).toBe("remote-user");
    expect(provider).toBe(stubRemoteUser);
  });

  test("ctx hint (sandboxPreference=default) routes to env kind", async () => {
    const ctx = stubCtx(makeLink(), { sandboxPreference: "default" });
    const { kind } = await resolveSandboxProvider(ctx, {
      userId: "u-1",
      branch: "deco/foo",
      virtualMcpMetadata: null,
    });
    // STUDIO_SANDBOX_RUNNER=docker pinned at top of file.
    expect(kind).toBe("docker");
  });

  test("remote-user resolution throws when link daemon is offline", async () => {
    // vmMap records `remote-user` but link is gone — caller (events/proxy
    // middleware) catches this and surfaces a failed phase / 503.
    const metadata = {
      vmMap: {
        "u-1": {
          "deco/foo": {
            "remote-user": {
              vmId: "vm_xyz",
              previewUrl: "https://p",
              sandboxUrl: "https://p",
              sandboxProviderKind: "remote-user",
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
