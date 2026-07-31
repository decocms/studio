/**
 * SANDBOX_START. Keyed by (userId, branch, sandboxProviderKind) in the Virtual
 * MCP's `sandboxMap`, where `userId` is the sandbox's OWNER — the thread's
 * creator on a thread-scoped branch, so a member opening a teammate's thread
 * resumes that thread's single sandbox instead of booting a private copy of the
 * same git branch (see `resolveSandboxUserId`).
 * Provider-agnostic — dispatches through the active `SandboxProvider`; this
 * handler only does `sandboxMap` bookkeeping. Branch defaults to a Bayer-style
 * `<greek-letter>-<constellation>` name (e.g. `alpha-centauri`) when omitted.
 *
 * Different sandbox provider kinds coexist as siblings under the same
 * (user, branch) key — no stale-sandbox teardown is needed on kind change.
 */

import { z } from "zod";
import type { SandboxRecord } from "@decocms/shared/sdk";
import {
  composeSandboxRef,
  normalizeSandboxProviderKind,
  sandboxDaemonImplSchema,
  type SandboxDaemonImpl,
  type SandboxProvider,
  type SandboxProviderKind,
  type Workload,
} from "@decocms/sandbox/provider";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "../../core/studio-context";
import {
  readValidatedSubmoduleCredentials,
  resolveRuntimeConfig,
  type RuntimeConfigMeta,
} from "./helpers";
import { resolveAndPushEnv } from "./resolve-env";
import { resolveSubmoduleCredentials } from "./resolve-submodule-creds";
import {
  readSandboxMap,
  removeSandboxMapEntry,
  resolveVm,
} from "./sandbox-map";
import {
  buildAnonymousCloneInfo,
  buildCloneInfo,
  ensureGithubCloneToken,
} from "../../shared/github-clone-info";
import {
  detectRepoRuntime,
  detectRepoRuntimeAnonymous,
} from "../../shared/github-runtime-detect";
import { generateBranchName } from "@decocms/shared/branch-name";
import { PACKAGE_MANAGER_CONFIG } from "@decocms/shared/runtime-defaults";
import { resolveSandboxProvider } from "../../sandbox/resolve-provider";
import { resolveDaemonImpl } from "../../sandbox/resolve-daemon-impl";
import {
  getThreadGithubRepo,
  getThreadHeadRef,
  resolveSandboxUserId,
  setThreadSandboxMapEntry,
  syntheticBranchToGitRef,
  threadIdFromBranch,
} from "./thread-repo";
import { isStickyHeadRefEnabled, pickGitBranch } from "../../sandbox/head-ref";
import { deriveOffloadAllowlist } from "../../object-storage/offload-allowlist";
import { getSettings } from "../../settings";
import { getPublicUrl } from "../../core/server-constants";
import { mintOrgFsConfigJson } from "../../file-storage/mount/provisioning";
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

const sandboxProviderKindInputSchema = z.enum([
  "agent-sandbox",
  "user-desktop",
  "cluster",
]);

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
        "Optional git branch to check out. When omitted the handler generates a Bayer-style `<greek-letter>-<constellation>` name (e.g. `alpha-centauri`) and uses it. The resolved branch is returned in the response so callers can persist it.",
      ),
    sandboxProviderKind: sandboxProviderKindInputSchema
      .optional()
      .describe(
        "Explicit runtime choice. Hosted provider is `agent-sandbox`; legacy `cluster` input is accepted only for compatibility and normalized to `agent-sandbox`. When omitted, defaults to `user-desktop` if the acting user's link daemon is online, else the env kind.",
      ),
    daemonImpl: sandboxDaemonImplSchema
      .optional()
      .describe(
        "Target this one sandbox at a specific sandbox daemon implementation, overriding the org's `sandboxGoDaemon` flag in either direction. Only honored on `agent-sandbox`, and only when the deployment configures a Go SandboxTemplate; otherwise the sandbox lands on `ts`. Applies to a sandbox being created — an existing sandbox keeps the binary it booted with.",
      ),
  }),
  outputSchema: z.object({
    previewUrl: z.string().nullable(),
    sandboxHandle: z.string(),
    branch: z.string(),
    isNewVm: z.boolean(),
    sandboxProviderKind: z.enum(["agent-sandbox", "user-desktop"]),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const resolvedBranch =
      input.branch ??
      generateBranchName(
        ctx.auth.user?.name ?? ctx.auth.user?.email?.split("@")[0],
      );

    // Resolve kind after loading metadata so recorded sandboxMap entries can
    // pin the provider when the caller did not pass an explicit kind.
    const userId = getUserId(ctx);
    if (!userId) throw new Error("User ID required");

    // Whose sandbox this is: the thread's creator for a thread-scoped branch, so
    // a member opening a teammate's thread resumes the ONE sandbox that thread
    // has instead of booting a private copy of the same git branch. `userId`
    // stays the caller for credential resolution + audit — see
    // resolveSandboxUserId.
    const sandboxUserId = await resolveSandboxUserId(
      ctx,
      resolvedBranch,
      userId,
    );

    const virtualMcp = await ctx.storage.virtualMcps.findById(
      input.virtualMcpId,
    );
    if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
      throw new Error("Virtual MCP not found");
    }
    const metadata = (virtualMcp.metadata ?? {}) as Record<string, unknown>;

    // Resolve the runner once. `resolveSandboxProvider` returns the
    // existing kind when sandboxMap already has an entry for (user, branch),
    // honors `input.sandboxProviderKind` as a caller override, and
    // otherwise applies the link-or-env default policy. We bind the
    // provider here so the kind we record in sandboxMap matches the runner
    // that actually `ensure`d the sandbox.
    const explicitKind = input.sandboxProviderKind
      ? normalizeSandboxProviderKind(input.sandboxProviderKind)
      : undefined;
    const { provider: runner, kind: providerKind } =
      await resolveSandboxProvider(ctx, {
        userId: sandboxUserId,
        branch: resolvedBranch,
        virtualMcpMetadata: metadata,
        explicitKind,
      });

    const existing: SandboxRecord | null = resolveVm(
      readSandboxMap(metadata),
      sandboxUserId,
      resolvedBranch,
      providerKind,
    );

    // Thread-scoped repo (bound by `load_repo`) wins over the agent's repo — the
    // same rule as `ensureSandbox`. Without this the frontend's auto-start
    // provisions a repo-LESS sandbox for the synthetic Decopilot agent (whose
    // metadata has no repo), so nothing clones and the dev server stays idle.
    // Derive the thread id from the branch since this path has no
    // `ctx.metadata.threadId`.
    const threadRepo = await getThreadGithubRepo(
      ctx,
      threadIdFromBranch(resolvedBranch) ?? ctx.metadata?.threadId,
    );
    const githubRepo =
      threadRepo ?? (metadata as GithubRepoMeta).githubRepo ?? null;

    const { entry, isNewVm } = await provisionSandbox({
      ctx,
      userId,
      sandboxUserId,
      orgId: organization.id,
      virtualMcpId: input.virtualMcpId,
      branch: resolvedBranch,
      metadata,
      githubRepo,
      existing,
      providerKind,
      runner,
      daemonImpl: input.daemonImpl,
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
  ctx: StudioContext,
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
  // See resolveSandboxUserId: one sandbox per thread, keyed by its creator.
  const sandboxUserId = await resolveSandboxUserId(ctx, input.branch, userId);
  const existing: SandboxRecord | null = resolveVm(
    readSandboxMap(metadata),
    sandboxUserId,
    input.branch,
    input.sandboxProviderKind,
  );

  const providerKind = input.sandboxProviderKind;

  // Resolve the runner up front: for user-desktop we must verify the cached
  // entry against the live daemon before trusting it (the daemon may have
  // restarted via `deco link` relink, leaving the sandboxMap pointing at a
  // dead handle). resolveSandboxProvider is cheap and idempotent.
  const { provider: runner } = await resolveSandboxProvider(ctx, {
    userId: sandboxUserId,
    branch: input.branch,
    virtualMcpMetadata: metadata,
    explicitKind: providerKind,
  });

  // Fast path: trust an agent-sandbox entry directly. For user-desktop, probe the
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
      sandboxUserId,
      input.branch,
      providerKind,
    ).catch((err) => {
      console.warn(
        "[ensureSandbox] failed to reap stale user-desktop entry",
        err,
      );
    });
  }

  // Thread-scoped repo wins over the agent's own repo: `load_repo` binds a repo
  // to the thread (the only place it can persist for the synthetic Decopilot
  // agent), and it's the per-conversation override for real repo-agents too.
  // Recover the thread id from the branch (`thread:<id>[/<conn>]`) so the
  // repo binding is found even on the frontend's SANDBOX_START auto-start path,
  // which doesn't set `ctx.metadata.threadId`. Falls back to the ctx value.
  const threadRepo = await getThreadGithubRepo(
    ctx,
    threadIdFromBranch(input.branch) ?? ctx.metadata?.threadId,
  );
  const githubRepo =
    threadRepo ?? (metadata as GithubRepoMeta).githubRepo ?? null;
  const { entry } = await provisionSandbox({
    ctx,
    userId,
    sandboxUserId,
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
  ctx: StudioContext;
  /** The caller. Resolves credentials (env secrets, submodule PATs) and stamps
   *  the audit fields on storage writes. */
  userId: string;
  /** Whose sandbox this is — the thread's creator for a thread-scoped branch,
   *  else the caller. Keys the claim, the runner state and the sandboxMap. See
   *  resolveSandboxUserId. */
  sandboxUserId: string;
  orgId: string;
  virtualMcpId: string;
  branch: string;
  metadata: Record<string, unknown>;
  githubRepo: GithubRepo | null;
  existing: SandboxRecord | null;
  providerKind: SandboxProviderKind;
  runner: SandboxProvider;
  /** `SANDBOX_START`'s explicit daemon-impl override, when the caller passed
   *  one. Absent on the `ensureSandbox` path, which falls back to the org flag. */
  daemonImpl?: SandboxDaemonImpl;
};

async function provisionSandbox(
  params: StartParams,
): Promise<{ entry: SandboxRecord; isNewVm: boolean }> {
  const {
    ctx,
    userId,
    sandboxUserId,
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
        connectionId?: string;
        userName: string;
        userEmail: string;
        branch: string;
        displayName: string;
        submoduleCredentials?: { host: string; token: string }[];
      }
    | undefined;

  if (githubRepo) {
    // Legacy repo-scoped children may mint through their source connection here.
    // buildCloneInfo and detectRepoRuntime refresh OAuth-shaped tokens before
    // using them, including refreshable repo-scoped GitHub children.
    if (githubRepo.connectionId) {
      await ensureGithubCloneToken({
        ctx,
        connectionId: githubRepo.connectionId,
        organizationId: orgId,
        forceRefresh: true,
        onLegacyMintError: (error) => {
          // Swallow + log: a failed mint intentionally falls through to
          // buildCloneInfo's own "No GitHub token found" throw below (sandbox
          // start fails loudly — never an unauthenticated clone).
          console.error(
            "[provisionSandbox] repo-scoped legacy token mint failed",
            {
              connectionId: githubRepo.connectionId,
              error: (error as Error).message,
            },
          );
        },
      });
    }

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

    // The git branch the daemon actually checks out and pushes. A synthetic
    // isolation key (thread:*) maps to a real, deterministic ref so work is
    // persisted to git on its own branch — never the repo default. The isolation
    // key itself (projectRef, handle, sandboxMap) stays synthetic below.
    //
    // A recorded `headRef` (the branch a live daemon last reported for this
    // thread — e.g. the PR branch the Super Agent committed on) wins over the
    // derived ref: the derived ref may never have been pushed, in which case
    // cloning it forks from the repo default and the preview serves pre-change
    // code while the work sits on the PR branch. Flagged off by default.
    const stickyHeadRef = isStickyHeadRefEnabled();
    const gitBranch = pickGitBranch({
      branch,
      derivedRef: syntheticBranchToGitRef(branch),
      recordedHeadRef: stickyHeadRef
        ? await getThreadHeadRef(ctx, threadIdFromBranch(branch))
        : null,
      sticky: stickyHeadRef,
    });

    // Private submodules live in repos the per-repo clone token can't reach;
    // resolve the user's per-host PATs here so they ride the initial daemon
    // config (the clone + `git submodule update` run during provisioning).
    const submoduleCredentials = await resolveSubmoduleCredentials({
      ctx,
      orgId,
      userId,
      entries: readValidatedSubmoduleCredentials(metadata),
    });

    repoOpts = {
      cloneUrl,
      // Persisted so the runner can re-mint on recovery; absent for anonymous.
      ...(githubRepo.connectionId
        ? { connectionId: githubRepo.connectionId }
        : {}),
      userName: gitUserName,
      userEmail: gitUserEmail,
      branch: gitBranch,
      displayName: `${githubRepo.owner}/${githubRepo.name}`,
      ...(submoduleCredentials.length > 0 ? { submoduleCredentials } : {}),
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
  // (empty allowlist) unless the control plane pushes the object-storage host
  // it mints presigned offload URLs against. Derive it from the control
  // plane's OWN trusted S3 config (never a request frame) and pass it through
  // the ensure control channel so it lands in the spawned daemon's boot env.
  // Only relevant for `user-desktop`; hosted execution reads its own S3 env.
  const offload =
    runner.kind === "user-desktop"
      ? await deriveOffloadAllowlist(ctx.objectStorage, {
          isProduction: getSettings().nodeEnv === "production",
        })
      : null;

  // Org-fs mounts: mint an fs-scoped token + build the daemon's ORGFS_CONFIG.
  // org-fs is the universal substrate now — both desktop links and hosted
  // pods always mount (hosted relies on the privileged org-fs sidecar
  // shipping in the default deploy). Guarded inside the helper: a mint
  // failure → undefined → no mounting, never breaks provisioning.
  //
  // DISABLE_ORGFS_MOUNTS is a debug escape hatch (opt-out, default off): it
  // skips provisioning the mount so a sandbox boots without org-fs, for
  // low-level mount debugging. NOT a supported "org-fs-off" product mode —
  // the prompt/tools still assume org-fs, so the agent's `org/` paths just
  // won't exist while it's set.
  const wantsOrgFs =
    (runner.kind === "user-desktop" || runner.kind === "agent-sandbox") &&
    !getSettings().orgFsMountsDisabled;
  // ctx.organization is unset on the decopilot vm-tools dispatch path (the
  // org travels as the `orgId` param there) — resolve the slug from the row
  // so chat-ephemeral sandboxes get mounts too.
  let orgFsConfigJson: string | undefined;
  if (wantsOrgFs) {
    const orgSlug =
      ctx.organization?.slug ??
      (
        await ctx.db
          .selectFrom("organization")
          .select(["slug"])
          .where("id", "=", orgId)
          .executeTakeFirst()
      )?.slug;
    if (orgSlug) {
      orgFsConfigJson = await mintOrgFsConfigJson(ctx, {
        orgSlug,
        orgId,
        baseUrl: getPublicUrl(),
      });
    }
  }

  // Go-daemon rollout gate. Only the hosted runner can honor it (the desktop
  // daemon is the TS bundle the link spawns), so skip the settings read
  // entirely elsewhere. `resolveDaemonImpl` applies prop → org flag → `ts`; the
  // runner then collapses `go` back to `ts` when no Go SandboxTemplate is
  // configured, and persists whichever one the claim actually got.
  const daemonImpl =
    runner.kind === "agent-sandbox"
      ? resolveDaemonImpl({
          explicit: params.daemonImpl,
          flags: params.daemonImpl
            ? null
            : ((await ctx.storage.organizationSettings.get(orgId))?.flags ??
              null),
        })
      : undefined;

  const sandbox = await runner.ensure(
    { userId: sandboxUserId, projectRef },
    {
      // Pass branch explicitly so the runner-side `computeHandle` agrees with
      // the sandbox-proxy's `computeClaimHandle`. Without it, a repo-less
      // VM falls back to `s-<hash>` while the proxy looks up `<branch>-<hash>`
      // and every proxy call 404s with `unknown handle` (see resilience
      // scenarios `link-dispatch-ws-partition` / `link-dispatch-log-replay`).
      branch,
      repo: repoOpts,
      workload,
      tenant: {
        orgId,
        // The sandbox's owner, so the pod's `user_id` label/metric matches the
        // claim handle it answers on.
        userId: sandboxUserId,
        ...(ctx.organization?.slug ? { orgSlug: ctx.organization.slug } : {}),
        ...(ctx.organization?.name ? { orgName: ctx.organization.name } : {}),
        ...(ctx.auth.user?.email ? { userEmail: ctx.auth.user.email } : {}),
        ...(ctx.auth.user?.name ? { userName: ctx.auth.user.name } : {}),
      },
      ...(offload
        ? {
            offloadAllowedHosts: offload.hosts,
            offloadAllowSameHostDev: offload.allowSameHostDev,
          }
        : {}),
      ...(orgFsConfigJson ? { orgFsConfigJson } : {}),
      ...(daemonImpl ? { daemonImpl } : {}),
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
    sandboxUserId,
    branch,
    params.providerKind,
    entry,
  );
  // Thread-scoped branch: the agent write above is a no-op for the synthetic
  // Decopilot agent, so also persist the record on the thread — the only place
  // the frontend reads previewUrl/handle from for these sandboxes. Applies to
  // EVERY provisioning path (load_repo, SANDBOX_START auto-start, fs tools).
  const threadId = threadIdFromBranch(branch);
  if (threadId) {
    await setThreadSandboxMapEntry(
      ctx,
      threadId,
      sandboxUserId,
      branch,
      params.providerKind,
      entry,
    );
  }

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
  ctx: StudioContext,
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
