/**
 * Unit tests for:
 *   - `computeDesktopSandboxHandle` — the pure, I/O-free handle derivation
 *     used at the pull/work-queue dispatch site (`pullDispatch`), where the
 *     daemon self-ensures the sandbox from the work item. Pull is the sole
 *     local transport (Transport Convergence), so this is the only
 *     handle-derivation site — the push ensure helpers were deleted with the
 *     push `remoteDispatch` path.
 *   - `resolveEffectiveVirtualMcpForHarness` — studio-pack runtime resolution.
 */
import { describe, expect, it } from "bun:test";

// dispatch-run transitively imports `@/api/app`, which loads
// `tools/sandbox/index.ts` and re-exports `SANDBOX_START` from "./start".
// Without this stub the re-export resolves to `undefined` against the mock and
// Bun throws "export 'SANDBOX_START' not found in './start'". No function under
// test calls `ensureSandbox`, so the mock body is a minimal placeholder.
import { mock } from "bun:test";
mock.module("@/tools/sandbox/start", () => ({
  ensureSandbox: async () => {
    throw new Error("ensureSandbox must not be called in these unit tests");
  },
  SANDBOX_START: { name: "SANDBOX_START" },
}));

const {
  buildHarnessWorkspaceInput,
  computeDesktopSandboxHandle,
  resolveEffectiveVirtualMcpForHarness,
} = await import("./dispatch-run");

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

describe("buildHarnessWorkspaceInput", () => {
  it("returns repo, branch, cwd, and connected GitHub state for repo-backed workspaces", () => {
    const result = buildHarnessWorkspaceInput({
      virtualMcp: {
        metadata: {
          githubRepo: {
            owner: "deco",
            name: "site",
            connectionId: "conn-1",
          },
        },
      },
      branch: "feature-branch",
      cwd: "/repo",
    });

    expect(result).toEqual({
      cwd: "/repo",
      repo: {
        owner: "deco",
        name: "site",
        connectedGithub: true,
      },
      branch: "feature-branch",
    });
  });

  it("marks public clone repo workspaces as not connected to GitHub", () => {
    const result = buildHarnessWorkspaceInput({
      virtualMcp: {
        metadata: {
          githubRepo: {
            owner: "deco",
            name: "public-site",
          },
        },
      },
      branch: "main",
      cwd: "/repo",
    });

    expect(result).toEqual({
      cwd: "/repo",
      repo: {
        owner: "deco",
        name: "public-site",
        connectedGithub: false,
      },
      branch: "main",
    });
  });

  it("returns null cwd for non-repo workspaces", () => {
    const result = buildHarnessWorkspaceInput({
      virtualMcp: { metadata: {} },
      branch: null,
    });

    expect(result).toEqual({
      cwd: null,
    });
  });

  it("returns null cwd for repo metadata when no repo checkout is available", () => {
    const result = buildHarnessWorkspaceInput({
      virtualMcp: {
        metadata: {
          githubRepo: {
            owner: "deco",
            name: "site",
            connectionId: "conn-1",
          },
        },
      },
      branch: "feature-branch",
      cwd: null,
    });

    expect(result).toEqual({
      cwd: null,
    });
  });
});

describe("resolveEffectiveVirtualMcpForHarness", () => {
  it("resolves studio-pack instructions and selected tools before harness dispatch", async () => {
    const virtualMcp = {
      id: "studio-brand-manager_org-1",
      title: "Brand Manager",
      description: "Manage brand contexts",
      icon: null,
      created_at: "2026-06-09T00:00:00.000Z",
      updated_at: "2026-06-09T00:00:00.000Z",
      created_by: "user-1",
      organization_id: "org-1",
      status: "active" as const,
      pinned: false,
      metadata: { instructions: "persisted instructions", keep: true },
      connections: [
        {
          connection_id: "org-1_self",
          selected_tools: ["BRAND_CONTEXT_LIST"],
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    };
    const ctx = {
      storage: {
        brandContext: {
          list: async () => [],
        },
      },
    };

    const resolved = await resolveEffectiveVirtualMcpForHarness({
      virtualMcp,
      agentId: virtualMcp.id,
      organizationId: "org-1",
      ctx: ctx as never,
    });

    expect(resolved).not.toBe(virtualMcp);
    expect(resolved.metadata).toMatchObject({ keep: true });
    expect(
      String((resolved.metadata as { instructions?: unknown }).instructions),
    ).toContain("does not have a brand context yet");
    expect(resolved.connections).toEqual([
      {
        connection_id: "org-1_self",
        selected_tools: ["BRAND_CONTEXT_CREATE", "BRAND_CONTEXT_EXTRACT"],
        selected_resources: null,
        selected_prompts: null,
      },
    ]);
  });

  it("restores API key tools when an installed manager has stale selections", async () => {
    const virtualMcp = {
      id: "studio-api-key-manager_org-1",
      title: "API Key Manager",
      description: "Manage API keys",
      icon: null,
      created_at: "2026-07-17T00:00:00.000Z",
      updated_at: "2026-07-17T00:00:00.000Z",
      created_by: "user-1",
      organization_id: "org-1",
      status: "active" as const,
      pinned: false,
      metadata: { instructions: "persisted instructions" },
      connections: [
        {
          connection_id: "org-1_self",
          selected_tools: [],
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    };

    const resolved = await resolveEffectiveVirtualMcpForHarness({
      virtualMcp,
      agentId: virtualMcp.id,
      organizationId: "org-1",
      ctx: {} as never,
    });

    expect(resolved.connections[0]?.selected_tools).toEqual([
      "API_KEY_CREATE",
      "API_KEY_LIST",
      "API_KEY_UPDATE",
      "API_KEY_DELETE",
      "SECRET_CREATE",
      "SECRET_LIST",
      "COLLECTION_VIRTUAL_MCP_LIST",
      "COLLECTION_VIRTUAL_MCP_GET",
      "COLLECTION_CONNECTIONS_LIST",
      "COLLECTION_CONNECTIONS_GET",
    ]);
  });
});
