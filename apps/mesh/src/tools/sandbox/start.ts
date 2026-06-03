/**
 * SANDBOX_START. Keyed by (userId, branch, sandboxProviderKind) in the Virtual MCP's `sandboxMap`.
 * Provider-agnostic — dispatches through the active `SandboxProvider`; this
 * handler only does `sandboxMap` bookkeeping. Branch defaults to
 * `deco/<adjective>-<noun>` when omitted.
 *
 * Different sandbox provider kinds coexist as siblings under the same
 * (user, branch) key — no stale-sandbox teardown is needed on kind change.
 */

import { z } from "zod";
import type { SandboxRecord } from "@decocms/mesh-sdk";
import {
  composeSandboxRef,
  type SandboxProvider,
  type SandboxProviderKind,
  type Workload,
} from "@decocms/sandbox/provider";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type MeshContext,
} from "../../core/mesh-context";
import {
  requireVmEntry,
  resolveRuntimeConfig,
  type RuntimeConfigMeta,
} from "./helpers";
import { resolveAndPushEnv } from "./resolve-env";
import {
  readSandboxMap,
  removeSandboxMapEntry,
  resolveVm,
} from "./sandbox-map";
import {
  buildAnonymousCloneInfo,
  buildCloneInfo,
} from "../../shared/github-clone-info";
import {
  detectRepoRuntime,
  detectRepoRuntimeAnonymous,
} from "../../shared/github-runtime-detect";
import { generateBranchName } from "../../shared/branch-name";
import { PACKAGE_MANAGER_CONFIG } from "../../shared/runtime-defaults";
import { resolveSandboxProvider } from "../../sandbox/resolve-provider";
import { deriveOffloadAllowlist } from "../../object-storage/offload-allowlist";
import { getSettings } from "../../settings";
import { setSandboxMapEntry } from "./sandbox-map";
import type { VirtualMCPUpdateData } from "../virtual/schema";

type GithubRepo = {
  owner: string;
  name: string;
  connectionId?: string;
};

type GithubRepoMeta = {
  githubRepo?: GithubRepo | null;
};

export const SANDBOX_START = defineTool({
  name: "SANDBOX_START",
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
    // Canonical-only. Migrations 092/097 swept persisted legacy values;
    // clients ship canonical strings after the SDK narrowed its union.
    sandboxProviderKind: z
      .enum(["cluster", "user-desktop"])
      .optional()
      .describe(
        "Explicit runtime choice. When omitted, defaults to `user-desktop` if the acting user's link daemon is online, else the cluster env kind.",
      ),
  }),
  outputSchema: z.object({
    previewUrl: z.string().nullable(),
    sandboxHandle: z.string(),
    branch: z.string(),
    isNewVm: z.boolean(),
    sandboxProviderKind: z.enum(["cluster", "user-desktop"]),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const resolvedBranch = input.branch ?? generateBranchName();

    // Resolve kind before requireVmEntry so the 3-level lookup uses the right key.
    // getUserId may return null here; requireVmEntry will throw if so.
    const earlyUserId = getUserId(ctx);
    if (!earlyUserId) throw new Error("User ID required");

    // Resolve the runner once. `resolveSandboxProvider` returns the
    // existing kind when sandboxMap already has an entry for (user, branch),
    // honors `input.sandboxProviderKind` as a caller override, and
    // otherwise applies the link-or-env default policy. We bind the
    // provider here so the kind we record in sandboxMap matches the runner
    // that actually `ensure`d the sandbox.
    const { provider: runner, kind: providerKind } =
      await resolveSandboxProvider(ctx, {
        userId: earlyUserId,
        branch: resolvedBranch,
        virtualMcpMetadata: null,
        explicitKind: input.sandboxProviderKind,
      });

    const {
      metadata,
      userId,
      organization,
      entry: existing,
    } = await requireVmEntry(
      {
        virtualMcpId: input.virtualMcpId,
        branch: resolvedBranch,
        sandboxProviderKind: providerKind,
      },
      ctx,
    );

    const githubRepo = (metadata as GithubRepoMeta).githubRepo ?? null;

    const { entry, isNewVm } = await provisionSandbox({
      ctx,
      userId,
      orgId: organization.id,
      virtualMcpId: input.virtualMcpId,
      branch: resolvedBranch,
      metadata,
      githubRepo,
      existing,
      providerKind,
      runner,
    });
    return {
      ...entry,
      branch: resolvedBranch,
      isNewVm,
      sandboxProviderKind: providerKind,
    };
  },
});

/**
 * Lazy provisioner for the always-on sandbox tools path. Mirrors SANDBOX_START's
 * flow but: (a) tolerates a missing GitHub repo (boots a blank sandbox),
 * and (b) takes a fast path when the existing sandboxMap entry already
 * matches the requested kind — avoiding a full `provider.ensure` round-trip
 * on every fresh stream when the sandbox is already registered.
 *
 * Unlike SANDBOX_START, `sandboxProviderKind` is required — callers (e.g. POST
 * /messages) must resolve the kind before calling this function.
 */
export async function ensureSandbox(
  input: {
    virtualMcpId: string;
    branch: string;
    sandboxProviderKind: SandboxProviderKind;
  },
  ctx: MeshContext,
): Promise<SandboxRecord> {
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
  const existing: SandboxRecord | null = resolveVm(
    readSandboxMap(metadata),
    userId,
    input.branch,
    input.sandboxProviderKind,
  );

  const providerKind = input.sandboxProviderKind;

  // Resolve the runner up front: for user-desktop we must verify the cached
  // entry against the live daemon before trusting it (the daemon may have
  // restarted via `deco link` relink, leaving the sandboxMap pointing at a
  // dead handle). resolveSandboxProvider is cheap and idempotent.
  const { provider: runner } = await resolveSandboxProvider(ctx, {
    userId,
    branch: input.branch,
    virtualMcpMetadata: metadata,
    explicitKind: providerKind,
  });

  // Fast path: trust a cluster entry directly. For user-desktop, probe the
  // daemon first — a relinked daemon has an empty sandbox map and answers the
  // liveness probe with 404, which means we must reap the stale entry and
  // re-provision (runner.ensure spawns a fresh sandbox on the new daemon).
  if (existing) {
    if (providerKind !== "user-desktop") return existing;
    const alive = await runner.alive(existing.sandboxHandle).catch(() => false);
    if (alive) return existing;
    await removeSandboxMapEntry(
      ctx.storage.virtualMcps,
      input.virtualMcpId,
      userId,
      userId,
      input.branch,
      providerKind,
    ).catch((err) => {
      console.warn(
        "[ensureSandbox] failed to reap stale user-desktop entry",
        err,
      );
    });
  }

  const githubRepo = (metadata as GithubRepoMeta).githubRepo ?? null;
  const { entry } = await provisionSandbox({
    ctx,
    userId,
    orgId: organization.id,
    virtualMcpId: input.virtualMcpId,
    branch: input.branch,
    metadata,
    githubRepo,
    existing: null,
    providerKind,
    runner,
  });
  return entry;
}

type StartParams = {
  ctx: MeshContext;
  userId: string;
  orgId: string;
  virtualMcpId: string;
  branch: string;
  metadata: Record<string, unknown>;
  githubRepo: GithubRepo | null;
  existing: SandboxRecord | null;
  providerKind: SandboxProviderKind;
  runner: SandboxProvider;
};

async function provisionSandbox(
  params: StartParams,
): Promise<{ entry: SandboxRecord; isNewVm: boolean }> {
  const {
    ctx,
    userId,
    orgId,
    virtualMcpId,
    branch,
    metadata,
    githubRepo,
    existing,
    runner,
  } = params;

  let { runtime, packageManager, port, packageManagerPath } =
    resolveRuntimeConfig(metadata);

  // Skip clone + lockfile probe entirely when no repo is connected — the
  // sandbox boots blank.
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
    // Connection-backed (authenticated) vs public-clone (anonymous). The
    // daemon's clone behavior is identical — only the URL and identity
    // change. Push-back fails in the anonymous case; that's the documented
    // trade-off of linking a repo without a GitHub connection.
    const { cloneUrl, gitUserName, gitUserEmail } = githubRepo.connectionId
      ? await buildCloneInfo(
          githubRepo.connectionId,
          githubRepo.owner,
          githubRepo.name,
          ctx.db,
          ctx.vault,
        )
      : buildAnonymousCloneInfo(githubRepo.owner, githubRepo.name);

    // Lockfile probe only when metadata has no PM. Used to be client-side in
    // the repo picker, but that introduced a race — SANDBOX_START fired from the
    // auto-start paths before `runtime` landed in metadata, and the daemon
    // got baked clone-only (no install, no dev server, UI stuck on setup).
    // Running it here piggybacks on the same request so the baked workload
    // always matches the detected PM; the result is persisted so subsequent
    // starts skip the probe.
    if (!packageManager) {
      const detected = githubRepo.connectionId
        ? await detectRepoRuntime(
            githubRepo.connectionId,
            githubRepo.owner,
            githubRepo.name,
            ctx.db,
            ctx.vault,
          )
        : await detectRepoRuntimeAnonymous(githubRepo.owner, githubRepo.name);
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

  // Missing workload = clone-only; the runner picks its default.
  // `devPort` is omitted unless the user explicitly pinned one — leaves
  // runners free to assign a unique dynamic port (user-desktop needs this;
  // multiple sandboxes on the user's machine share the host network and
  // can't all bind 3000).
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

  // Message-offload SSRF allowlist. The user-desktop daemon fails closed
  // (empty allowlist) unless the cluster pushes the object-storage host it
  // mints presigned offload URLs against. Derive it from the cluster's OWN
  // trusted S3 config (never a request frame) and pass it through the ensure
  // control channel so it lands in the spawned daemon's boot env. Only
  // relevant for `user-desktop`; the cluster daemon reads its own S3 env.
  const offload =
    runner.kind === "user-desktop"
      ? await deriveOffloadAllowlist(ctx.objectStorage, {
          isProduction: getSettings().nodeEnv === "production",
        })
      : null;

  const sandbox = await runner.ensure(
    { userId, projectRef },
    {
      // Pass branch explicitly so the runner-side `computeHandle` agrees with
      // the sandbox-proxy's `computeClaimHandle`. Without it, a repo-less
      // VM falls back to `s-<hash>` while the proxy looks up `<branch>-<hash>`
      // and every proxy call 404s with `unknown handle` (see resilience
      // scenarios `link-dispatch-ws-partition` / `link-dispatch-log-replay`).
      branch,
      repo: repoOpts,
      workload,
      tenant: { orgId, userId },
      ...(offload
        ? {
            offloadAllowedHosts: offload.hosts,
            offloadAllowSameHostDev: offload.allowSameHostDev,
          }
        : {}),
    },
  );

  // Resolve declared env (literals + secret refs) and push to the daemon
  // *before* it can start install/dev. Daemon deep-merges, so resuming an
  // already-claimed sandbox stays idempotent.
  const envEntries = (metadata as RuntimeConfigMeta).runtime?.env ?? null;
  await resolveAndPushEnv({
    ctx,
    runner,
    handle: sandbox.handle,
    orgId,
    userId,
    entries: envEntries,
  });

  // Preserve `createdAt` across resumes so the booting overlay's elapsed
  // timer doesn't reset on re-run.
  const isResume = !!existing && existing.sandboxHandle === sandbox.handle;
  const createdAt =
    isResume && existing?.createdAt ? existing.createdAt : Date.now();

  const runtimeSelected =
    (metadata as RuntimeConfigMeta).runtime?.selected ?? null;
  const runtimePort = (metadata as RuntimeConfigMeta).runtime?.port ?? null;
  const runtimePath = (metadata as RuntimeConfigMeta).runtime?.path ?? null;

  const entry: SandboxRecord = {
    sandboxHandle: sandbox.handle,
    previewUrl: sandbox.previewUrl,
    sandboxApiUrl: sandbox.previewUrl, // for desktop the two are equal
    sandboxProviderKind: runner.kind,
    createdAt,
    startedWith: {
      packageManager: runtimeSelected,
      port: runtimePort,
      path: runtimePath,
    },
  };

  await setSandboxMapEntry(
    ctx.storage.virtualMcps,
    virtualMcpId,
    userId,
    userId,
    branch,
    params.providerKind,
    entry,
  );

  // Different handle = new sandbox (stale entry / orphan recovery / state miss).
  const isNewVm = !existing || existing.sandboxHandle !== sandbox.handle;
  return { entry, isNewVm };
}

/**
 * Writes back the detected runtime so subsequent SANDBOX_STARTs for this virtual
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
