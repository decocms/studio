/**
 * SANDBOX_START. Hosted agent sandboxes are keyed by (organization, virtual
 * MCP, branch) in agent_sandbox_sessions. User-desktop remains keyed by
 * (user, branch, kind) in the Virtual MCP's sandboxMap.
 *
 * Different provider kinds can coexist for a branch without changing the
 * user-desktop persistence contract.
 */

import { z } from "zod";
import type { SandboxRecord } from "@decocms/shared/sdk";
import {
  composeSandboxRef,
  normalizeSandboxProviderKind,
  sharedSandboxId,
  type SandboxProvider,
  type SandboxProviderKind,
  userSandboxId,
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
  readValidatedRuntimeEnv,
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
import { PACKAGE_MANAGER_CONFIG } from "@decocms/shared/runtime-defaults";
import { resolveSandboxProvider } from "../../sandbox/resolve-provider";
import { computeClaimHandle } from "../../sandbox/claim-handle";
import {
  getThreadGithubRepo,
  setThreadSandboxMapEntry,
  syntheticBranchToGitRef,
  threadBranch,
  threadIdFromBranch,
} from "./thread-repo";
import { deriveOffloadAllowlist } from "../../object-storage/offload-allowlist";
import { getSettings } from "../../settings";
import { getPublicUrl } from "../../core/server-constants";
import { mintOrgFsConfigJson } from "../../file-storage/mount/provisioning";
import { setSandboxMapEntry } from "./sandbox-map";
import type { VirtualMCPUpdateData } from "../virtual/schema";
import type { AgentSandboxSessionStorage } from "../../storage/agent-sandbox-sessions";

type GithubRepo = {
  owner: string;
  name: string;
  connectionId?: string;
};

type GithubRepoMeta = {
  githubRepo?: GithubRepo | null;
};

function usesAgentSandboxSession(kind: SandboxProviderKind): boolean {
  return kind === "agent-sandbox";
}

function sessionToSandboxRecord(
  session: Awaited<
    ReturnType<StudioContext["storage"]["agentSandboxSessions"]["find"]>
  > | null,
): SandboxRecord | null {
  if (
    !session ||
    session.desiredState !== "running" ||
    session.status !== "ready" ||
    !session.sandboxHandle
  ) {
    return null;
  }
  return {
    sandboxHandle: session.sandboxHandle,
    previewUrl: session.previewUrl,
    sandboxApiUrl: session.sandboxApiUrl,
    sandboxProviderKind: "agent-sandbox",
    createdAt: Date.parse(session.createdAt),
    startedWith: session.startedWith as SandboxRecord["startedWith"],
  };
}

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
        "Optional git branch to check out. When omitted, the handler derives the thread's own synthetic `thread:<id>` branch from the thread context; with neither a branch nor a thread it errors rather than defaulting to a shared branch. The resolved branch is returned in the response so callers can persist it.",
      ),
    sandboxProviderKind: sandboxProviderKindInputSchema
      .optional()
      .describe(
        "Explicit runtime choice. Hosted provider is `agent-sandbox`; legacy `cluster` input is accepted only for compatibility and normalized to `agent-sandbox`. When omitted, defaults to `user-desktop` if the acting user's link daemon is online, else the env kind.",
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
    // Prefer the caller's branch; otherwise isolate on the thread's own
    // synthetic `thread:<id>` branch (same per-thread scheme as thread creation
    // and `load_repo`) so a branchless start never lands on a shared working
    // branch. There is deliberately NO default-to-`staging` fallback: a shared
    // branch must be an explicit choice, never something we silently drift into.
    const resolvedBranch =
      input.branch ??
      (ctx.metadata?.threadId ? threadBranch(ctx.metadata.threadId) : null);
    if (!resolvedBranch) {
      throw new Error(
        "SANDBOX_START requires an explicit `branch` or a thread context; refusing to default to a shared branch.",
      );
    }

    // Resolve kind after loading metadata so recorded sandboxMap entries can
    // pin the provider when the caller did not pass an explicit kind.
    const userId = getUserId(ctx);
    if (!userId) throw new Error("User ID required");

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
        userId,
        branch: resolvedBranch,
        virtualMcpId: input.virtualMcpId,
        virtualMcpMetadata: metadata,
        explicitKind,
      });

    const existing: SandboxRecord | null = usesAgentSandboxSession(providerKind)
      ? sessionToSandboxRecord(
          await ctx.storage.agentSandboxSessions.find({
            organizationId: organization.id,
            virtualMcpId: input.virtualMcpId,
            branch: resolvedBranch,
          }),
        )
      : resolveVm(
          readSandboxMap(metadata),
          userId,
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
  const providerKind = input.sandboxProviderKind;
  const existing: SandboxRecord | null = usesAgentSandboxSession(providerKind)
    ? sessionToSandboxRecord(
        await ctx.storage.agentSandboxSessions.find({
          organizationId: organization.id,
          virtualMcpId: input.virtualMcpId,
          branch: input.branch,
        }),
      )
    : resolveVm(readSandboxMap(metadata), userId, input.branch, providerKind);

  // Resolve the runner up front: for user-desktop we must verify the cached
  // entry against the live daemon before trusting it (the daemon may have
  // restarted via `deco link` relink, leaving the sandboxMap pointing at a
  // dead handle). resolveSandboxProvider is cheap and idempotent.
  const { provider: runner } = await resolveSandboxProvider(ctx, {
    userId,
    branch: input.branch,
    virtualMcpId: input.virtualMcpId,
    virtualMcpMetadata: metadata,
    explicitKind: providerKind,
  });

  // Fast path: trust an agent-sandbox entry directly. For user-desktop, probe the
  // daemon first — a relinked daemon has an empty sandbox map and answers the
  // liveness probe with 404, which means we must reap the stale entry and
  // re-provision (runner.ensure spawns a fresh sandbox on the new daemon).
  if (existing && !usesAgentSandboxSession(providerKind)) {
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
  if (!usesAgentSandboxSession(params.providerKind)) {
    return provisionSandboxInner(params, null);
  }

  const locator = {
    organizationId: params.orgId,
    virtualMcpId: params.virtualMcpId,
    branch: params.branch,
  };
  await finishInterruptedSharedTransition(params, locator);
  const started = await params.ctx.storage.agentSandboxSessions.withLock(
    locator,
    (sessions) =>
      sessions.beginStart(
        locator,
        params.userId,
        threadIdFromBranch(params.branch),
      ),
  );
  try {
    return await provisionSandboxInner(params, {
      locator,
      generation: started.generation,
      sessions: params.ctx.storage.agentSandboxSessions,
    });
  } catch (error) {
    await params.ctx.storage.agentSandboxSessions
      .failStart(
        locator,
        started.generation,
        error instanceof Error ? error.message : String(error),
      )
      .catch(() => {});
    throw error;
  }
}

async function finishInterruptedSharedTransition(
  params: StartParams,
  locator: {
    organizationId: string;
    virtualMcpId: string;
    branch: string;
  },
): Promise<void> {
  const pending = await params.ctx.storage.agentSandboxSessions.withLock(
    locator,
    (sessions) => sessions.find(locator),
  );
  if (
    !pending ||
    (pending.status !== "stopping" && pending.status !== "reaping")
  ) {
    return;
  }

  const sandboxId = sharedSandboxId(
    composeSandboxRef({
      orgId: params.orgId,
      virtualMcpId: params.virtualMcpId,
      branch: params.branch,
    }),
  );
  if (pending.sandboxHandle) {
    await params.runner.delete(pending.sandboxHandle, sandboxId);
  }
  await params.ctx.storage.agentSandboxSessions.withLock(
    locator,
    (sessions) => {
      if (pending.status === "stopping") {
        return sessions.completeStop(locator, pending.generation);
      }
      if (!pending.sandboxHandle) {
        throw new Error("Reaping agent sandbox session is missing its handle");
      }
      return sessions.completeReap(
        locator,
        pending.generation,
        pending.sandboxHandle,
      );
    },
  );
}

async function provisionSandboxInner(
  params: StartParams,
  sharedStart: {
    locator: {
      organizationId: string;
      virtualMcpId: string;
      branch: string;
    };
    generation: number;
    sessions: AgentSandboxSessionStorage;
  } | null,
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

  if (sharedStart) {
    await assertSharedSandboxSecrets(ctx, {
      orgId,
      userId,
      metadata,
    });
  }

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
    const gitBranch = branch.startsWith("thread:")
      ? syntheticBranchToGitRef(branch)
      : branch;

    // Private submodules live in repos the per-repo clone token can't reach;
    // resolve the user's per-host PATs here so they ride the initial daemon
    // config (the clone + `git submodule update` run during provisioning).
    const submoduleCredentials = await resolveSubmoduleCredentials({
      ctx,
      orgId,
      userId,
      entries: readValidatedSubmoduleCredentials(metadata),
      organizationSecretsOnly: !!sharedStart,
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

  const sandboxId = sharedStart
    ? sharedSandboxId(projectRef)
    : userSandboxId(userId, projectRef);
  if (sharedStart) {
    await sharedStart.sessions.recordProvisioningHandle(
      sharedStart.locator,
      sharedStart.generation,
      computeClaimHandle(sandboxId, branch),
    );
  }
  const sandbox = await runner.ensure(sandboxId, {
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
      ...(sharedStart ? {} : { userId }),
      ...(ctx.organization?.slug ? { orgSlug: ctx.organization.slug } : {}),
      ...(ctx.organization?.name ? { orgName: ctx.organization.name } : {}),
      ...(!sharedStart && ctx.auth.user?.email
        ? { userEmail: ctx.auth.user.email }
        : {}),
      ...(!sharedStart && ctx.auth.user?.name
        ? { userName: ctx.auth.user.name }
        : {}),
    },
    ...(offload
      ? {
          offloadAllowedHosts: offload.hosts,
          offloadAllowSameHostDev: offload.allowSameHostDev,
        }
      : {}),
    ...(orgFsConfigJson ? { orgFsConfigJson } : {}),
  });

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
    organizationSecretsOnly: !!sharedStart,
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

  if (sharedStart) {
    const completed = await sharedStart.sessions.completeStart(
      sharedStart.locator,
      sharedStart.generation,
      entry,
    );
    if (!completed) {
      await runner.delete(entry.sandboxHandle, sandboxId).catch(() => {});
      throw new Error("Sandbox start was superseded by a stop");
    }
  } else {
    await setSandboxMapEntry(
      ctx.storage.virtualMcps,
      virtualMcpId,
      userId,
      userId,
      branch,
      params.providerKind,
      entry,
    );
    // Legacy/desktop thread-scoped entries remain user-specific.
    const threadId = threadIdFromBranch(branch);
    if (threadId) {
      await setThreadSandboxMapEntry(
        ctx,
        threadId,
        userId,
        branch,
        params.providerKind,
        entry,
      );
    }
  }

  // Different handle = new sandbox (stale entry / orphan recovery / state miss).
  const isNewVm = !existing || existing.sandboxHandle !== sandbox.handle;
  return { entry, isNewVm };
}

async function assertSharedSandboxSecrets(
  ctx: StudioContext,
  args: {
    orgId: string;
    userId: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const references = [
    ...(readValidatedRuntimeEnv(args.metadata) ?? []).flatMap((entry) =>
      entry.kind === "secret"
        ? [{ id: entry.secretId, label: `environment variable ${entry.key}` }]
        : [],
    ),
    ...(readValidatedSubmoduleCredentials(args.metadata) ?? []).map(
      (entry) => ({
        id: entry.secretId,
        label: `submodule credential ${entry.host}`,
      }),
    ),
  ];
  for (const reference of references) {
    const info = await ctx.storage.secrets.findById(
      reference.id,
      args.orgId,
      args.userId,
    );
    if (info.scope !== "organization") {
      throw new Error(
        `Shared agent sandboxes require organization-scoped secrets (${reference.label})`,
      );
    }
  }
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
