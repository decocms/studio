/**
 * SANDBOX_START. Keyed by (userId, branch, "agent-sandbox") in the Virtual
 * MCP's `sandboxMap`, where `userId` is the sandbox's OWNER — the thread's
 * creator on a thread-scoped branch, so a member opening a teammate's thread
 * resumes that thread's single sandbox instead of booting a private copy of the
 * same git branch (see `resolveSandboxUserId`).
 * Branch is minted from the caller's
 * slug + a timestamp (`generateBranchName`) when omitted — a fresh identity, so
 * callers that have a branch must pass it or they get a second sandbox.
 */

import { z } from "zod";
import type { SandboxRecord } from "@decocms/shared/sdk";
import {
  composeSandboxRef,
  type SandboxPurpose,
  type Workload,
} from "@decocms/sandbox/provider";
import type { AgentSandboxProvider } from "@decocms/sandbox/provider/agent-sandbox";
import type { EnsureRepo } from "@decocms/sandbox/provider";
import { sleep } from "@decocms/shared/std";
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
  findReusableRepoConnection,
  getRepoScope,
} from "@decocms/shared/github-repo-scope";
import {
  buildAnonymousCloneInfo,
  buildCloneInfo,
  ensureGithubCloneToken,
} from "../../shared/github-clone-info";
import {
  detectRepoRuntime,
  detectRepoRuntimeAnonymous,
} from "../../shared/github-runtime-detect";
import {
  branchUserLabel,
  generateBranchName,
} from "@decocms/shared/branch-name";
import { PACKAGE_MANAGER_CONFIG } from "@decocms/shared/runtime-defaults";
import { getAgentSandboxProvider } from "../../sandbox/lifecycle";
import { stampRuntimeIfAbsent } from "../thread/stamp-runtime-if-absent";
import { parseThreadRuntime } from "@decocms/shared/thread/session-runtime";
import {
  getThreadGithubRepo,
  getThreadGithubRepos,
  getThreadHeadRef,
  resolveSandboxUserId,
  setThreadSandboxMapEntry,
  syntheticBranchToGitRef,
  threadIdFromBranch,
} from "./thread-repo";
import { pickGitBranch } from "../../sandbox/head-ref";
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
        "Git branch to check out. Pass the thread's branch whenever the caller has one: when omitted the handler mints a fresh `<user-slug>-<timestamp>` name, which becomes a SEPARATE sandbox from the one the thread's own branch resolves to. The resolved branch is returned in the response so callers can persist it.",
      ),
    threadId: z
      .string()
      .optional()
      .describe(
        "The session asking for a sandbox. A thread stamped `cms` is refused — that session reads and writes over the decofile API and a pod would be invisible to it. Optional: an unstamped (legacy) thread is always allowed, and so is a caller with no thread.",
      ),
  }),
  outputSchema: z.object({
    previewUrl: z.string().nullable(),
    sandboxHandle: z.string(),
    branch: z.string(),
    isNewVm: z.boolean(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const resolvedBranch =
      input.branch ?? generateBranchName(branchUserLabel(ctx.auth.user));

    // A CMS session must never provision: the pod it got would be unreachable
    // from its own surfaces. Only a LITERAL stamp refuses — an unstamped legacy
    // thread still has to be able to start one.
    const askingThreadId =
      threadIdFromBranch(resolvedBranch) ??
      input.threadId ??
      ctx.metadata?.threadId;
    if (askingThreadId) {
      const asking = await ctx.storage.threads
        .get(askingThreadId)
        .catch(() => null);
      const stamp = parseThreadRuntime(
        (asking?.metadata as { runtime?: unknown } | null)?.runtime,
      );
      if (stamp === "cms") {
        throw new Error(
          "This chat is a CMS session and does not use a sandbox. Start a coding session to get one.",
        );
      }
    }

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

    const runner = await getAgentSandboxProvider(ctx);

    const existing: SandboxRecord | null = resolveVm(
      readSandboxMap(metadata),
      sandboxUserId,
      resolvedBranch,
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
      threadRepos: await getThreadGithubRepos(
        ctx,
        threadIdFromBranch(resolvedBranch) ?? ctx.metadata?.threadId,
      ),
      existing,
      runner,
    });
    // A pod means a coding session. This is the web's path — `ensureSandbox`'s
    // own drain never runs here — so record it where the id is known.
    if (askingThreadId) {
      void stampRuntimeIfAbsent(ctx, askingThreadId, "sandbox");
    }
    return {
      ...entry,
      branch: resolvedBranch,
      isNewVm,
    };
  },
});

/**
 * Lazy provisioner for the always-on sandbox tools path. Mirrors SANDBOX_START's
 * flow but: (a) tolerates a missing GitHub repo (boots a blank sandbox),
 * and (b) takes a fast path when the existing sandboxMap entry already
 * matches — avoiding a full `provider.ensure` round-trip
 * on every fresh stream when the sandbox is already registered.
 */
export async function ensureSandbox(
  input: {
    virtualMcpId: string;
    branch: string;
    /**
     * What the sandbox is for. `harness-run` — one headless agent loop, no
     * preview — drops the application workload (install + dev server) from the
     * daemon config and, on the hosted runner, moves the pod onto the
     * agent-run SandboxTemplate + warm pool. Defaults to `interactive`.
     */
    purpose?: SandboxPurpose;
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
  );

  const runner = await getAgentSandboxProvider(ctx);

  // A recorded entry is trusted only if a pod actually answers at it. Nothing
  // but SANDBOX_DELETE removes a cell, so an evicted pod leaves one behind
  // forever; probing it is what makes that self-healing rather than sticky.
  if (existing) {
    // A probe that ERRORS is not evidence the pod is gone — treat it as alive,
    // the same way the events handler does. Reaping on a throttled control-plane
    // call would tear down a healthy sandbox and re-clone it from scratch.
    const alive = await runner.alive(existing.sandboxHandle).catch(() => true);
    if (alive) return existing;
    await removeSandboxMapEntry(
      ctx.storage.virtualMcps,
      input.virtualMcpId,
      userId,
      sandboxUserId,
      input.branch,
    ).catch((err) => {
      console.warn("[ensureSandbox] failed to reap stale entry", err);
    });
  }

  // Thread-scoped repo wins over the agent's own repo: `load_repo` binds a repo
  // to the thread (the only place it can persist for the synthetic Decopilot
  // agent), and it's the per-conversation override for real repo-agents too.
  // Recover the thread id from the branch (`thread:<id>[/<conn>]`) so the
  // repo binding is found even on the frontend's SANDBOX_START auto-start path,
  // which doesn't set `ctx.metadata.threadId`. Falls back to the ctx value.
  const provisioningThreadId =
    threadIdFromBranch(input.branch) ?? ctx.metadata?.threadId;
  // A pod means a coding session; record it so the claim never has to guess.
  if (provisioningThreadId) {
    void stampRuntimeIfAbsent(ctx, provisioningThreadId, "sandbox");
  }
  const threadRepo = await getThreadGithubRepo(ctx, provisioningThreadId);
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
    threadRepos: await getThreadGithubRepos(ctx, provisioningThreadId),
    existing: null,
    runner,
    ...(input.purpose ? { purpose: input.purpose } : {}),
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
  /** The thread's secondary checkouts, accumulated by `TASK_ADD_REPO`. */
  threadRepos?: GithubRepo[];
  existing: SandboxRecord | null;
  runner: AgentSandboxProvider;
  /** See `ensureSandbox`'s `purpose`. `harness-run` implies checkout-only. */
  purpose?: SandboxPurpose;
};

/**
 * `EnsureRepo` entries for a thread's secondary checkouts.
 *
 * Skips the primary when it turns up in the list, so a repo cannot be cloned
 * twice into two directories. A repo whose connection has since gone is dropped
 * with a log rather than sent with a dead clone URL: one revoked connection
 * should cost its own checkout, never the pod.
 */
async function buildExtraRepoOpts(args: {
  ctx: StudioContext;
  orgId: string;
  repos: GithubRepo[];
  primary: GithubRepo | null;
  gitUserName: string;
  gitUserEmail: string;
}): Promise<EnsureRepo[]> {
  const primaryKey = args.primary
    ? `${args.primary.owner}/${args.primary.name}`.toLowerCase()
    : null;
  const out: EnsureRepo[] = [];
  for (const repo of args.repos) {
    if (`${repo.owner}/${repo.name}`.toLowerCase() === primaryKey) continue;
    if (!repo.connectionId) continue;
    try {
      const { cloneUrl } = await buildCloneInfo(
        repo.connectionId,
        repo.owner,
        repo.name,
        args.ctx.db,
        args.ctx.vault,
      );
      out.push({
        cloneUrl,
        connectionId: repo.connectionId,
        userName: args.gitUserName,
        userEmail: args.gitUserEmail,
        displayName: `${repo.owner}/${repo.name}`,
        submoduleCredentials: [],
      });
    } catch (err) {
      console.warn(
        `[provisionSandbox] skipping secondary ${repo.owner}/${repo.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return out;
}

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
    threadRepos,
    existing,
    runner,
    purpose,
  } = params;
  // One agent loop needs the checkout, not the install + dev server.
  const cloneOnly = purpose === "harness-run";

  // A recorded connectionId can dangle — deleting a connection (force-delete,
  // or another agent's delete tearing down its repo-scoped child) removes
  // aggregation rows but never rewrites `metadata.githubRepo` on other agents
  // that recorded it — and the clone path below fails loudly on a connectionId
  // with no connection behind it. Re-point at a live connection covering the
  // same repo when one exists.
  const githubRepo = params.githubRepo
    ? await healDanglingRepoConnection({
        ctx,
        orgId,
        virtualMcpId,
        userId,
        githubRepo: params.githubRepo,
      })
    : null;

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
    const stickyHeadRef = getSettings().sandboxStickyHeadRefEnabled;
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
      // Always set, empty included — see buildConfigPayload: an absent field
      // means "keep current" to the daemon, which would make a revoked PAT
      // outlive its deletion.
      submoduleCredentials,
    };
  }

  // The secondaries this thread accumulated through `TASK_ADD_REPO`. Sent on
  // every provision, so a recreated pod gets every checkout back instead of
  // just the primary. Their clone URLs are minted here for the same reason the
  // primary's are: the embedded token lives an hour.
  const extraRepos = await buildExtraRepoOpts({
    ctx,
    orgId,
    repos: threadRepos ?? [],
    primary: githubRepo,
    gitUserName: repoOpts?.userName ?? "",
    gitUserEmail: repoOpts?.userEmail ?? "",
  });

  // Missing workload = clone-only; the runner picks its default. `devPort` is
  // omitted unless the user explicitly pinned one.
  const workload: Workload | undefined =
    runtime && packageManager && !cloneOnly
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

  // Org-fs mounts: mint an fs-scoped token and build the daemon config payload.
  // Hosted pods mount through the privileged org-fs sidecar shipped in the
  // default deployment. Guarded inside the helper: a mint failure → undefined
  // → no mounting, never breaks provisioning.
  //
  // DISABLE_ORGFS_MOUNTS is a debug escape hatch (opt-out, default off): it
  // skips provisioning the mount so a sandbox boots without org-fs, for
  // low-level mount debugging. NOT a supported "org-fs-off" product mode —
  // the prompt/tools still assume org-fs, so the agent's `org/` paths just
  // won't exist while it's set.
  const wantsOrgFs = !getSettings().orgFsMountsDisabled;
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

  // Ask before claiming: a sandbox the cluster cannot place sits `Pending`
  // (`FailedScheduling: Insufficient memory`) until the 180s readiness timeout
  // fails the run. On a node with room for 4, an 8-card auto-fix produced 4
  // failures that way, and each retry re-entered the same full node. Waiting
  // here turns over-admission into a queue. Bounded well under the readiness
  // timeout this call already tolerates, so it adds no new liveness risk; past
  // the bound the error is phrased for the task-board retry to recognize as
  // infrastructure.
  await waitForSchedulableCapacity(runner);

  const sandbox = await runner.ensure(
    { userId: sandboxUserId, projectRef },
    {
      // Annotation only — the handle comes from `projectRef`, which already
      // carries this branch, so runner and proxy agree without being told.
      branch,
      repo: repoOpts,
      extraRepos,
      workload,
      // Explicit, not implied by the absent `workload`: the daemon autodetects a
      // package manager from the lockfile when the config names none, so an
      // omitted workload still installed (404 packages, competing with the run
      // that only wanted the checkout).
      cloneOnly,
      ...(purpose ? { purpose } : {}),
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
      ...(orgFsConfigJson ? { orgFsConfigJson } : {}),
    },
  );

  // Resolve declared env (literals + secret refs) and push to the daemon
  // *before* it can start install/dev. Daemon deep-merges, so resuming an
  // already-claimed sandbox stays idempotent.
  const envEntries = readValidatedRuntimeEnv(metadata);
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
    entry,
  );
  // Thread-scoped branch: the agent write above is a no-op for the synthetic
  // Decopilot agent, so also persist the record on the thread — the only place
  // the frontend reads previewUrl/handle from for these sandboxes. Applies to
  // EVERY provisioning path (load_repo, SANDBOX_START auto-start, fs tools).
  // ctx fallback: a `pinnedRef` run is keyed by a real git ref, not `thread:<id>`.
  const threadId = threadIdFromBranch(branch) ?? ctx.metadata?.threadId;
  if (threadId) {
    await setThreadSandboxMapEntry(ctx, threadId, sandboxUserId, branch, entry);
  }

  // Different handle = new sandbox (stale entry / orphan recovery / state miss).
  const isNewVm = !existing || existing.sandboxHandle !== sandbox.handle;
  return { entry, isNewVm };
}

/**
 * Falls back to a live connection covering the same repo when the recorded
 * `githubRepo.connectionId` no longer resolves (see the call site for how it
 * dangles). Org-shared connections win — findReusableRepoConnection. The heal
 * is persisted back onto the agent's metadata (best-effort) so every other
 * consumer of the recorded id — git publish, credential sync, the companion
 * repo-reuse plan — reads the live connection too, instead of re-healing here
 * on every start. With no replacement the repo is returned unchanged and
 * buildCloneInfo keeps failing loudly (GITHUB_NOT_AUTHENTICATED → the client's
 * reconnect affordance); stripping the id would silently downgrade a private
 * repo to an anonymous clone that can't push.
 */
async function healDanglingRepoConnection(params: {
  ctx: StudioContext;
  orgId: string;
  virtualMcpId: string;
  userId: string;
  githubRepo: GithubRepo;
}): Promise<GithubRepo> {
  const { ctx, orgId, virtualMcpId, userId, githubRepo } = params;
  if (!githubRepo.connectionId) return githubRepo;
  const recorded = await ctx.storage.connections.findById(
    githubRepo.connectionId,
    orgId,
  );
  if (recorded) return githubRepo;

  const { items } = await ctx.storage.connections.list(orgId);
  const replacement = findReusableRepoConnection(
    items,
    githubRepo.owner,
    githubRepo.name,
  );
  if (!replacement) {
    console.warn(
      "[provisionSandbox] recorded repo connection no longer exists and no live connection covers the repo",
      { virtualMcpId, connectionId: githubRepo.connectionId },
    );
    return githubRepo;
  }
  console.warn("[provisionSandbox] healed dangling repo connection", {
    virtualMcpId,
    staleConnectionId: githubRepo.connectionId,
    connectionId: replacement.id,
  });

  // Persist only while the agent's own metadata still records the stale id —
  // a thread-scoped repo or a concurrent update must not be overwritten.
  try {
    const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
    const meta = (virtualMcp?.metadata ?? {}) as Record<string, unknown>;
    const current = (meta as GithubRepoMeta).githubRepo;
    if (current?.connectionId === githubRepo.connectionId) {
      const scope = getRepoScope(replacement);
      await ctx.storage.virtualMcps.update(virtualMcpId, userId, {
        metadata: {
          ...meta,
          githubRepo: {
            ...current,
            connectionId: replacement.id,
            ...(scope ? { installationId: scope.installationId } : {}),
          },
        } as VirtualMCPUpdateData["metadata"],
      });
    }
  } catch (err) {
    console.warn(
      "[provisionSandbox] failed to persist healed repo connection",
      {
        virtualMcpId,
        error: (err as Error).message,
      },
    );
  }

  return { ...githubRepo, connectionId: replacement.id };
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

/** How long `ensureSandbox` waits for the cluster to have room. Deliberately
 *  under `waitForSandboxReady`'s own 180s: this call's callers already tolerate
 *  that much, so staying inside it means the wait can't trip a liveness window
 *  that the readiness wait wouldn't have tripped anyway. A cluster still full
 *  after this needs nodes, not patience — the run fails and the task-board
 *  retry re-dispatches it with backoff. */
const CAPACITY_WAIT_MS = 150_000;
/** Re-ask this often. The provider caches its answer (3s), so this is the poll
 *  rate that matters. */
const CAPACITY_POLL_MS = 5_000;

/**
 * Park until the provider says another sandbox can actually be scheduled.
 *
 * The signal is the scheduler's own verdict on pods it already refused to place
 * (see `capacity.ts`), so it is lagging by one admission: the first
 * over-subscribed claim is still made, and it is what makes this false for
 * everyone behind it. That is the trade — one run pays the readiness timeout
 * instead of every run in the burst.
 */
async function waitForSchedulableCapacity(
  runner: AgentSandboxProvider,
): Promise<void> {
  const deadline = Date.now() + CAPACITY_WAIT_MS;
  let logged = false;
  while (!(await runner.hasSchedulableCapacity())) {
    if (Date.now() >= deadline) {
      // Phrased so the task-board's `isTransientRunFailure` recognizes it: this
      // is capacity, not the task's fault, so the card must be retried.
      throw new Error(
        "sandbox provisioning failed: the cluster has had no room to schedule " +
          `another sandbox for ${Math.round(CAPACITY_WAIT_MS / 1000)}s`,
      );
    }
    if (!logged) {
      logged = true;
      console.warn(
        "[ensureSandbox] waiting for cluster capacity — a sandbox pod cannot be scheduled right now",
      );
    }
    await sleep(CAPACITY_POLL_MS);
  }
}
