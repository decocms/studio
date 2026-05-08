/**
 * VM_START. Keyed by (userId, branch) in the Virtual MCP's `vmMap`.
 * Runner-agnostic — dispatches through the active `SandboxRunner`; this
 * handler only does `vmMap` bookkeeping. Branch defaults to
 * `deco/<adjective>-<noun>` when omitted.
 *
 * Runner flips: if the existing entry's `runnerKind` differs from the env's
 * current runner, the stale VM is torn down under its original runner before
 * the new one is provisioned. Old VMs are ephemeral — not preserved.
 */

import { z } from "zod";
import type { VmMapEntry } from "@decocms/mesh-sdk";
import {
  composeSandboxRef,
  resolveRunnerKindFromEnv,
  type RunnerKind,
  type Workload,
} from "@decocms/sandbox/runner";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type MeshContext,
} from "../../core/mesh-context";
import { requireVmEntry, resolveRuntimeConfig } from "./helpers";
import { readVmMap, resolveVm } from "./vm-map";
import { buildCloneInfo } from "../../shared/github-clone-info";
import { detectRepoRuntime } from "../../shared/github-runtime-detect";
import { generateBranchName } from "../../shared/branch-name";
import { PACKAGE_MANAGER_CONFIG } from "../../shared/runtime-defaults";
import { getRunnerByKind, getSharedRunner } from "../../sandbox/lifecycle";
import { setVmMapEntry } from "./vm-map";
import type { VirtualMCPUpdateData } from "../virtual/schema";

type GithubRepo = {
  owner: string;
  name: string;
  connectionId?: string;
};

type GithubRepoMeta = {
  githubRepo?: GithubRepo | null;
};

export const VM_START = defineTool({
  name: "VM_START",
  description: "Start a sandbox with the connected GitHub repo and dev server.",
  annotations: {
    title: "Start VM Preview",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    virtualMcpId: z.string().describe("Virtual MCP ID"),
    branch: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional git branch to check out. When omitted the handler generates `deco/<adjective>-<noun>` and uses it. The resolved branch is returned in the response so callers can persist it.",
      ),
  }),
  outputSchema: z.object({
    previewUrl: z.string().nullable(),
    vmId: z.string(),
    branch: z.string(),
    isNewVm: z.boolean(),
    runnerKind: z.enum(["host", "docker", "freestyle", "agent-sandbox"]),
  }),

  handler: async (input, ctx) => {
    const resolvedBranch = input.branch ?? generateBranchName();
    const {
      metadata,
      userId,
      organization,
      entry: existing,
    } = await requireVmEntry(
      { virtualMcpId: input.virtualMcpId, branch: resolvedBranch },
      ctx,
    );

    const githubRepo = (metadata as GithubRepoMeta).githubRepo ?? null;

    const runnerKind = resolveRunnerKindFromEnv();
    await reapStaleRunner(ctx, existing, runnerKind);

    const { entry, isNewVm } = await provisionSandbox({
      ctx,
      userId,
      orgId: organization.id,
      virtualMcpId: input.virtualMcpId,
      branch: resolvedBranch,
      metadata,
      githubRepo,
      existing,
    });
    return {
      ...entry,
      branch: resolvedBranch,
      isNewVm,
      runnerKind,
    };
  },
});

/**
 * Lazy provisioner for the always-on VM tools path. Mirrors VM_START's
 * flow but: (a) tolerates a missing GitHub repo (boots blank under Docker),
 * and (b) takes a fast path when the existing vmMap entry already matches
 * the current runner kind — avoiding a full `runner.ensure` round-trip on
 * every fresh stream when the VM is already registered.
 */
export async function ensureVmForBranch(
  input: { virtualMcpId: string; branch: string },
  ctx: MeshContext,
): Promise<VmMapEntry> {
  // Inline auth + lookup; the standard `requireVmEntry` runs
  // `ctx.access.check()`, which expects resource scoping that the
  // streaming turn doesn't carry. Storage writes below still go through
  // the per-port authorization hooks.
  requireAuth(ctx);
  const organization = requireOrganization(ctx);
  const userId = getUserId(ctx);
  if (!userId) throw new Error("User ID required");

  const virtualMcp = await ctx.storage.virtualMcps.findById(input.virtualMcpId);
  if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
    throw new Error("Virtual MCP not found");
  }
  const metadata = (virtualMcp.metadata ?? {}) as Record<string, unknown>;
  const existing: VmMapEntry | null = resolveVm(
    readVmMap(metadata),
    userId,
    input.branch,
  );

  const runnerKind = resolveRunnerKindFromEnv();

  // Fast path: vmMap already has an entry under the current runner. Trust
  // it; matches the prior `activeVm` behavior in built-in-tools.
  if (existing && (existing.runnerKind ?? "freestyle") === runnerKind) {
    return existing;
  }

  await reapStaleRunner(ctx, existing, runnerKind);

  const githubRepo = (metadata as GithubRepoMeta).githubRepo ?? null;
  const { entry } = await provisionSandbox({
    ctx,
    userId,
    orgId: organization.id,
    virtualMcpId: input.virtualMcpId,
    branch: input.branch,
    metadata,
    githubRepo,
    existing,
  });
  return entry;
}

async function reapStaleRunner(
  ctx: MeshContext,
  existing: VmMapEntry | null,
  currentKind: RunnerKind,
): Promise<void> {
  if (!existing) return;
  // Legacy entries (pre-runnerKind) default to freestyle, matching VM_DELETE.
  const priorKind: RunnerKind = existing.runnerKind ?? "freestyle";
  if (priorKind === currentKind) return;

  // Freestyle idle-times out its VMs on its own, so active teardown is
  // unnecessary — and the freestyle SDK throws on ref() when the current
  // env has no FREESTYLE_API_KEY (typical docker-only deploy).
  if (priorKind === "freestyle") return;

  try {
    const priorRunner = await getRunnerByKind(ctx, priorKind);
    await priorRunner.delete(existing.vmId);
  } catch (err) {
    console.error(
      `[VM_START] stale ${priorKind} ${existing.vmId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

type StartParams = {
  ctx: MeshContext;
  userId: string;
  orgId: string;
  virtualMcpId: string;
  branch: string;
  metadata: Record<string, unknown>;
  githubRepo: GithubRepo | null;
  existing: VmMapEntry | null;
};

async function provisionSandbox(
  params: StartParams,
): Promise<{ entry: VmMapEntry; isNewVm: boolean }> {
  const {
    ctx,
    userId,
    orgId,
    virtualMcpId,
    branch,
    metadata,
    githubRepo,
    existing,
  } = params;

  if (githubRepo && !githubRepo.connectionId) {
    throw new Error("GitHub connection id missing on virtual MCP metadata");
  }

  let { runtime, packageManager, port, packageManagerPath } =
    resolveRuntimeConfig(metadata);

  // Skip clone + lockfile probe entirely when no repo is connected — the
  // sandbox boots blank (Docker only; freestyle requires a baked clone).
  let repoOpts:
    | {
        cloneUrl: string;
        userName: string;
        userEmail: string;
        branch: string;
        displayName: string;
      }
    | undefined;

  if (githubRepo) {
    const { cloneUrl, gitUserName, gitUserEmail } = await buildCloneInfo(
      githubRepo.connectionId!,
      githubRepo.owner,
      githubRepo.name,
      ctx.db,
      ctx.vault,
    );

    // Lockfile probe only when metadata has no PM. Used to be client-side in
    // the repo picker, but that introduced a race — VM_START fired from the
    // auto-start paths before `runtime` landed in metadata, and the daemon
    // got baked clone-only (no install, no dev server, UI stuck on setup).
    // Running it here piggybacks on the same request so the baked workload
    // always matches the detected PM; the result is persisted so subsequent
    // starts skip the probe.
    if (!packageManager) {
      const detected = await detectRepoRuntime(
        githubRepo.connectionId!,
        githubRepo.owner,
        githubRepo.name,
        ctx.db,
        ctx.vault,
      );
      if (detected) {
        packageManager = detected.packageManager;
        runtime = PACKAGE_MANAGER_CONFIG[detected.packageManager].runtime;
        port = detected.devPort ?? port;
        await persistDetectedRuntime(
          ctx,
          virtualMcpId,
          userId,
          detected.packageManager,
          detected.devPort,
        );
      }
    }

    repoOpts = {
      cloneUrl,
      userName: gitUserName,
      userEmail: gitUserEmail,
      branch,
      displayName: `${githubRepo.owner}/${githubRepo.name}`,
    };
  }

  // Missing workload = clone-only. Freestyle treats it as "node, no install,
  // no dev server"; Docker lets the runner pick its default. `devPort` is
  // omitted unless the user explicitly pinned one — leaves runners free to
  // assign a unique dynamic port (host runner needs this; multiple sandboxes
  // share the host network and can't all bind 3000).
  const workload: Workload | undefined =
    runtime && packageManager
      ? {
          runtime,
          packageManager,
          ...(port !== null ? { devPort: Number(port) } : {}),
          ...(packageManagerPath ? { packageManagerPath } : {}),
        }
      : undefined;

  const projectRef = composeSandboxRef({
    orgId,
    virtualMcpId,
    branch,
  });
  const runner = await getSharedRunner(ctx);
  const sandbox = await runner.ensure(
    { userId, projectRef },
    {
      repo: repoOpts,
      workload,
      tenant: { orgId, userId },
    },
  );

  // Preserve `createdAt` across resumes so the booting overlay's elapsed
  // timer doesn't reset on re-run.
  const isResume = !!existing && existing.vmId === sandbox.handle;
  const createdAt =
    isResume && existing?.createdAt ? existing.createdAt : Date.now();

  const entry: VmMapEntry = {
    vmId: sandbox.handle,
    previewUrl: sandbox.previewUrl,
    runnerKind: runner.kind,
    createdAt,
  };

  await setVmMapEntry(
    ctx.storage.virtualMcps,
    virtualMcpId,
    userId,
    userId,
    branch,
    entry,
  );

  // Different handle = new sandbox (stale entry / orphan recovery / state miss).
  const isNewVm = !existing || existing.vmId !== sandbox.handle;
  return { entry, isNewVm };
}

/**
 * Writes back the detected runtime so subsequent VM_STARTs for this virtual
 * MCP skip the GitHub probe and the client surfaces the resolved PM. Shape
 * matches what the picker previously wrote (`{ selected, port }`), so
 * readers (resolveRuntimeConfig, any client inspectors) keep working.
 */
async function persistDetectedRuntime(
  ctx: MeshContext,
  virtualMcpId: string,
  actingUserId: string,
  packageManager: string,
  devPort: string | null,
): Promise<void> {
  const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
  if (!virtualMcp) return;
  const meta = (virtualMcp.metadata ?? {}) as Record<string, unknown>;
  await ctx.storage.virtualMcps.update(virtualMcpId, actingUserId, {
    metadata: {
      ...meta,
      runtime: { selected: packageManager, port: devPort },
    } as VirtualMCPUpdateData["metadata"],
  });
}
