/**
 * `TASK_ADD_REPO` — clone one of the org's repos into the sandbox a task run is
 * ALREADY running in.
 *
 * Why not `load_repo`: that tool provisions a NEW sandbox on a repo-specific
 * branch, which is fine for Decopilot (in-process, its fs tools can be rebound)
 * and useless here — the claude-code agent loop lives inside a pod, and its
 * `bash`/read/write hit that pod's disk. The repo has to land in the pod the run
 * is already in. So this tool touches the pod, not the pool: it binds the repo
 * to the thread, pushes a credentialed clone URL onto the running daemon's
 * config channel, and waits for the checkout.
 *
 * That is what lets a task run start before "which repo" is answered. Before
 * this, claude-code took a task only when the org had exactly ONE importable
 * repo (`pickSoleTaskRepo`) because the checkout was resolved at dispatch;
 * everything else fell back to Decopilot.
 *
 * The sandbox key is whatever the run was DISPATCHED on (NOT `threads.branch`) — see
 * `resolveSandboxBranch`. Deriving it (from the repo like `load_repo`, or as the
 * bare key this tool used to assume) misses the pod the agent loop is in.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "@/core/studio-context";
import { selectLoadableRepos } from "@/harnesses/decopilot/built-in-tools/load-repo";
import { pickGitBranch } from "@/sandbox/head-ref";
import { getAgentSandboxProvider } from "@/sandbox/lifecycle";
import {
  buildCloneInfo,
  ensureGithubCloneToken,
} from "@/shared/github-clone-info";
import { resolveVm } from "@/tools/sandbox/sandbox-map";
import {
  getThreadSandboxMap,
  resolveSandboxBranchForThread,
  resolveSandboxUserId,
  syntheticBranchToGitRef,
} from "@/tools/sandbox/thread-repo";
import { retry, sleep } from "@decocms/shared/std";
import type { AgentSandboxProvider } from "@decocms/sandbox/provider/agent-sandbox";
import {
  secondaryRepoDirNames,
  secondaryRepoDirName,
} from "@decocms/shared/secondary-repo-dirs";
import { requireTaskRunContext } from "./task-run-context";

/**
 * Re-mint the clone credential unless it has at least this much life left.
 *
 * A GitHub App installation token lives 1h from mint and cannot be issued for
 * longer, so asking for "at least an hour" means "freshly minted": the stored
 * token is minutes old at best (the pod booted with it) and would strand the
 * run's `git push`/`gh` halfway through. 55min (rather than a flat 60) leaves
 * room for mint latency, so a token minted by THIS call is never immediately
 * re-minted by the next one.
 */
const CLONE_TOKEN_MIN_TTL_MS = 55 * 60 * 1000;

/**
 * How long to wait for the run's sandbox record to appear before giving up.
 *
 * The record is written when `provisionSandbox` finishes; the harness can call
 * this tool as its first action, which on 13 production runs beat that write
 * and threw. The model then re-called the tool blind — three times each — so
 * the wait already happens, just as whole extra model turns. Bounded and short:
 * the pod is already up (it is running the caller), so this is a database write
 * landing, not a boot.
 */
const SANDBOX_RECORD_WAIT_ATTEMPTS = 4;
const SANDBOX_RECORD_WAIT_MIN_MS = 250;
const SANDBOX_RECORD_WAIT_MAX_MS = 2_000;

/**
 * The run's sandbox record, waiting out the provisioning write if it has not
 * landed yet. `null` once the budget is spent — the caller reports that as the
 * hard failure it is.
 */
async function waitForSandboxRecord(
  ctx: StudioContext,
  threadId: string,
  sandboxUserId: string,
  branch: string,
): Promise<ReturnType<typeof resolveVm>> {
  return retry(
    async () => {
      const record = resolveVm(
        await getThreadSandboxMap(ctx, threadId),
        sandboxUserId,
        branch,
      );
      if (!record) throw new Error("sandbox record not written yet");
      return record;
    },
    {
      maxAttempts: SANDBOX_RECORD_WAIT_ATTEMPTS,
      minTimeout: SANDBOX_RECORD_WAIT_MIN_MS,
      maxTimeout: SANDBOX_RECORD_WAIT_MAX_MS,
      jitter: 0,
    },
  ).catch(() => null);
}

/**
 * Wait at most this long for the checkout before answering anyway.
 *
 * MUST stay under the harness's MCP tool-call timeout, which is 60s: past that
 * the caller has already abandoned the call, so every extra second of polling
 * buys nothing and the model is told the add FAILED even when the clone lands
 * moments later. This was 180s, and the 120s beyond the cutoff were spent
 * probing a pod for an answer no one would read — an autonomous run then
 * re-cloned a repo it already had.
 *
 * A clone still in flight at the deadline is reported as "may still be in
 * progress" with the directory to look in, which is the honest answer and
 * one the model can act on.
 */
const CLONE_TIMEOUT_MS = 45_000;
const CLONE_POLL_MS = 1_500;
/** Consecutive probe failures that mean the pod is gone, not slow. */
const CLONE_MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Secondary checkouts a single run may accumulate.
 *
 * Nothing else bounds `TASK_ADD_REPO`: the model can call it once per repo the
 * org has imported, and each call clones into the pod and appends to the
 * thread's `githubRepos` list forever (`appendThreadGithubRepo` never
 * shrinks it). An org with a large connected-repo catalog would otherwise let
 * one run pile up an unbounded number of pod checkouts and an unbounded
 * `git.repositories` config payload pushed to the daemon on every add.
 */
export const MAX_SECONDARY_REPOS = 20;

/**
 * Whether adding `candidate` would push a thread's secondary checkouts past
 * the cap. A repo the thread already has is always let through — appending it
 * again is a no-op in storage, not a new checkout, so it can never be what
 * fills the cap.
 */
export function secondaryRepoCapExceeded(
  existing: { owner: string; name: string }[],
  candidate: { owner: string; name: string },
  cap = MAX_SECONDARY_REPOS,
): boolean {
  const key = (r: { owner: string; name: string }) =>
    `${r.owner}/${r.name}`.toLowerCase();
  const candidateKey = key(candidate);
  if (existing.some((r) => key(r) === candidateKey)) return false;
  return existing.length >= cap;
}

/** One bash command in the run's pod. Throws on a non-2xx from the daemon. */
async function podBash(
  provider: AgentSandboxProvider,
  handle: string,
  threadId: string,
  command: string,
): Promise<{ stdout: string; exitCode: number }> {
  const res = await provider.proxyDaemonRequest(handle, "/_sandbox/bash", {
    method: "POST",
    // `x-thread-id` keeps the daemon's org-fs link pointed at THIS run's
    // subtree; without it the workspace routes repoint it to the plain repo
    // link, undoing what the run's own dispatch set up.
    headers: new Headers({
      "content-type": "application/json",
      "x-thread-id": threadId,
    }),
    body: JSON.stringify({ command }),
  });
  if (!res.ok) {
    throw new Error(`sandbox bash failed (${res.status} ${res.statusText})`);
  }
  const body = (await res.json()) as { stdout?: string; exitCode?: number };
  return { stdout: body.stdout ?? "", exitCode: body.exitCode ?? 0 };
}

/**
 * Interpret the clone probe (`__CLONED__` marker + `ls -A`). A HEAD ref can
 * appear before the checkout does, so entries — not the marker — are what make
 * it ready. Pure, so the readiness rule is unit-tested.
 */
export function parseRepoProbe(stdout: string): {
  cloned: boolean;
  listing: string;
} {
  const entries = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== ".git" && l !== "__CLONED__");
  return { cloned: entries.length > 0, listing: entries.join("\n") };
}

/**
 * Point `gh` at the credential the clone just stored on `origin`.
 *
 * The harness process was spawned before the repo existed, and the daemon builds
 * `GH_TOKEN` from the clone URL at spawn time (`RunEnv`) — so this run's `gh`
 * has no token and no way to be handed one through its environment.
 * `hosts.yml` is the other place `gh` looks. The token is read out of `origin`
 * inside the pod, so it never crosses the wire a second time and never lands in
 * a command line.
 */
const GH_AUTH_COMMAND = [
  'token=$(git remote get-url origin | sed -n "s|.*x-access-token:\\([^@]*\\)@.*|\\1|p")',
  '[ -n "$token" ] || exit 0',
  'mkdir -p "${HOME:-/root}/.config/gh"',
  "umask 077",
  'printf "github.com:\\n  oauth_token: %s\\n  git_protocol: https\\n" "$token" > "${HOME:-/root}/.config/gh/hosts.yml"',
].join("\n");

/** The org's importable repos, newest lookup each call (an import can land
 *  while a run is in flight). */
async function listOrgRepos(ctx: StudioContext, orgId: string) {
  const { items } = await ctx.storage.connections.list(orgId, {
    slug: "mcp-github",
  });
  return selectLoadableRepos(items);
}

/**
 * The daemon's `git.repositories` entries for a thread's secondary checkouts.
 *
 * Every clone URL is minted fresh here rather than reused from a previous call:
 * they embed a GitHub App installation token that lives an hour, and this same
 * payload is what a recreated pod replays. A repo whose connection has since
 * gone is dropped rather than sent with a dead URL, so one revoked connection
 * costs its own checkout and not the others.
 */
async function secondaryRepoConfigs(
  ctx: StudioContext,
  repos: { owner: string; name: string; connectionId?: string }[],
): Promise<
  { cloneUrl: string; repoName: string; submoduleCredentials: never[] }[]
> {
  const dirNames = secondaryRepoDirNames(repos);
  const out: {
    cloneUrl: string;
    repoName: string;
    submoduleCredentials: never[];
  }[] = [];
  for (const [i, repo] of repos.entries()) {
    if (!repo.connectionId) continue;
    try {
      const { cloneUrl } = await buildCloneInfo(
        repo.connectionId,
        repo.owner,
        repo.name,
        ctx.db,
        ctx.vault,
        { bufferMs: CLONE_TOKEN_MIN_TTL_MS },
      );
      out.push({ cloneUrl, repoName: dirNames[i]!, submoduleCredentials: [] });
    } catch (err) {
      console.warn(
        `[TASK_ADD_REPO] skipping secondary ${repo.owner}/${repo.name}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return out;
}

export const TASK_ADD_REPO = defineTool({
  name: "TASK_ADD_REPO",
  description:
    "Clone one of this organization's repositories into your working directory. " +
    "Your working directory is EMPTY until you call this — do not look for " +
    "files, and do not run git, before it returns. Call it once, with the " +
    "repository the task is about; it waits for the checkout and returns the " +
    "repository root listing, so you can start reading files immediately after. " +
    "`git` and `gh` are authenticated once it returns. Call TASK_ADD_REPO with " +
    "no arguments to list the repositories available.",
  annotations: {
    title: "Add Repository",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    connectionId: z
      .string()
      .optional()
      .describe(
        "connectionId of the repository to clone. Omit to list the available repositories.",
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    /** Set when no repo was cloned — either a listing request or a bad id. */
    repositories: z
      .array(z.object({ connectionId: z.string(), repo: z.string() }))
      .optional(),
    repo: z.string().optional(),
    cloned: z.boolean().optional(),
    /** The repository root, one entry per line. */
    files: z.string().optional(),
    message: z.string(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const userId = getUserId(ctx);
    if (!userId) throw new Error("User ID required");
    const { threadId } = requireTaskRunContext();

    const repos = await listOrgRepos(ctx, organization.id);
    const repo = input.connectionId
      ? repos.find((r) => r.connectionId === input.connectionId)
      : undefined;
    if (!repo) {
      const repositories = repos.map((r) => ({
        connectionId: r.connectionId,
        repo: `${r.owner}/${r.repo}`,
      }));
      return {
        success: false,
        repositories,
        message: input.connectionId
          ? `No imported repository for connectionId "${input.connectionId}". Pick one of the repositories listed.`
          : repositories.length === 0
            ? "This organization has no repositories imported, so none can be cloned."
            : "Pick a repository and call TASK_ADD_REPO again with its connectionId.",
      };
    }

    const thread = await ctx.storage.threads.get(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);

    /**
     * The sandbox key, from the one derivation every sandbox consumer shares —
     * NOT `threads.branch` raw, which this used to read.
     *
     * They are different namespaces, and the mismatch was silent and fatal: a
     * run whose column holds a git ref (`sandbox/thread-<id>` on a
     * continuation, or a plain PR head like `fix/foo` on a re-run) never
     * matched the `sandboxMap`, which is keyed by the SYNTHETIC key the
     * dispatcher provisioned on. 48 production runs died on "No sandbox is
     * registered" — every one a task that could not clone, so never shipped,
     * after the model had already been paid for.
     */
    const branch = await resolveSandboxBranchForThread(ctx, {
      threadId,
      // The branch the run was DISPATCHED on. Passing it is what makes the
      // shared derivation keep a bare `thread:<id>` key (its `runBranch`
      // pinning rule) — omitted, a repo-less run fell through to `"ephemeral"`
      // and missed the pod it is executing in. Safe to pass raw: a real git ref
      // in this column does not match the bare key, so it falls through to the
      // same derivation as before.
      runBranch: thread.branch,
    });
    const sandboxUserId = await resolveSandboxUserId(ctx, branch, userId);
    const provider = await getAgentSandboxProvider(ctx);
    const record = await waitForSandboxRecord(
      ctx,
      threadId,
      sandboxUserId,
      branch,
    );
    if (!record) {
      throw new Error(
        `No sandbox is registered for this run (thread ${threadId}), so there ` +
          `is nowhere to clone into.`,
      );
    }

    const existingPrimary = (
      thread.metadata as { githubRepo?: { owner?: string } } | null
    )?.githubRepo?.owner;
    const existingSecondaries =
      (
        thread.metadata as {
          githubRepos?: { owner: string; name: string }[];
        } | null
      )?.githubRepos ?? [];
    if (
      existingPrimary &&
      secondaryRepoCapExceeded(existingSecondaries, {
        owner: repo.owner,
        name: repo.repo,
      })
    ) {
      return {
        success: false,
        repo: `${repo.owner}/${repo.repo}`,
        cloned: false,
        message:
          `This run already has ${MAX_SECONDARY_REPOS} additional repositories checked out, ` +
          `which is the limit. Work with what's already checked out instead of adding another.`,
      };
    }

    // Fresh credential BEFORE anything is written: a clone URL is only useful
    // with a live token behind it, and this is the failure worth reporting
    // as "could not add the repo" rather than half-binding one.
    await ensureGithubCloneToken({
      ctx,
      connectionId: repo.connectionId,
      organizationId: organization.id,
      forceRefresh: true,
      onLegacyMintError: (error) =>
        console.error("[TASK_ADD_REPO] legacy repo-scoped mint failed", {
          connectionId: repo.connectionId,
          error: (error as Error).message,
        }),
    });
    const { cloneUrl, gitUserName, gitUserEmail } = await buildCloneInfo(
      repo.connectionId,
      repo.owner,
      repo.repo,
      ctx.db,
      ctx.vault,
      { bufferMs: CLONE_TOKEN_MIN_TTL_MS },
    );

    const bound = {
      url: `https://github.com/${repo.owner}/${repo.repo}`,
      owner: repo.owner,
      name: repo.repo,
      installationId: repo.installationId,
      connectionId: repo.connectionId,
    };
    // Bind the repo to the thread. This is what every later consumer reads —
    // the shutdown git sync, a re-provision's credential refresh, the board's
    // PR extraction — so it has to be persisted, not just handed to the daemon.
    //
    // The FIRST repo is the primary: `githubRepo` is what drives the sandbox's
    // package-manager probe, dev server and preview, and a second call must not
    // move that out from under a running dev server. Later ones accumulate in
    // `githubRepos` and land as secondary checkouts.
    const isPrimary = !existingPrimary;
    const secondaries = isPrimary
      ? []
      : await ctx.storage.threads.appendThreadGithubRepo(threadId, bound);
    if (isPrimary) {
      await ctx.storage.threads.update(threadId, {
        metadata: { ...(thread.metadata ?? {}), githubRepo: bound },
        updated_by: userId,
      });
    }

    /**
     * The daemon reads its clone target off the config channel. A primary
     * classifies as a branch-change and runs the clone step (`cloneOnly` was
     * set at provision, so no install and no dev server follow). A secondary
     * classifies as nothing — `Classify` has no opinion on `git.repositories` —
     * and is instead swept off the daemon's step queue on every config apply,
     * which is what keeps it from waiting out the primary's install. The
     * explicit `setup/clone` below is the belt for both.
     */
    const gitRef = pickGitBranch({
      branch,
      derivedRef: syntheticBranchToGitRef(branch),
      recordedHeadRef: null,
      sticky: false,
    });
    const configRes = await provider.proxyDaemonRequest(
      record.sandboxHandle,
      "/_sandbox/config",
      {
        method: "PUT",
        headers: new Headers({ "content-type": "application/json" }),
        // ⚠️ SECURITY: `cloneUrl` embeds a GitHub token. Never log this body.
        body: JSON.stringify({
          git: {
            // The full list every time, not just the new entry: the daemon's
            // merge replaces this key, and a recreated pod has to be able to
            // read one config and know every checkout it owes.
            ...(isPrimary
              ? {
                  repository: {
                    cloneUrl,
                    branch: gitRef,
                    repoName: `${repo.owner}/${repo.repo}`,
                  },
                }
              : { repositories: await secondaryRepoConfigs(ctx, secondaries) }),
            identity: { userName: gitUserName, userEmail: gitUserEmail },
          },
        }),
      },
    );
    if (!configRes.ok) {
      throw new Error(
        `the sandbox rejected the repository (${configRes.status} ${configRes.statusText})`,
      );
    }
    await provider
      .proxyDaemonRequest(record.sandboxHandle, "/_sandbox/setup/clone", {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: "{}",
      })
      .catch((err) => {
        // The config push above already triggers the clone; this is the belt.
        console.warn("[TASK_ADD_REPO] explicit clone kick failed", err);
      });

    // Bash lands in the daemon's own repo dir, which is the PRIMARY. Probing
    // there for a secondary reports the primary's checkout as this call's
    // success, immediately and with the wrong file listing, so a secondary has
    // to be waited for where it actually lands. `$PWD`'s parent rather than a
    // literal `/app`, so the layout stays the daemon's to define.
    // Named against the whole accumulated list, the same way provisioning names
    // it, so the directory survives a pod restart.
    const secondaryDirName = isPrimary
      ? null
      : secondaryRepoDirName(secondaries, {
          owner: repo.owner,
          name: repo.repo,
        });
    const checkoutDir =
      isPrimary || !secondaryDirName
        ? "."
        : `"$(dirname "$PWD")/repos/${secondaryDirName}"`;

    // Wait for the checkout: the whole point is that the model can read files on
    // the next tool call instead of polling an empty directory itself.
    const deadline = Date.now() + CLONE_TIMEOUT_MS;
    let cloned = false;
    let listing = "";
    let failures = 0;
    // A checkout is revealed progressively, so one non-empty listing can still
    // be mid-clone. Require it to STABILIZE across two probes.
    let previous: string | null = null;
    while (Date.now() < deadline) {
      const probe = await podBash(
        provider,
        record.sandboxHandle,
        threadId,
        `cd ${checkoutDir} 2>/dev/null || exit 1; if git rev-parse HEAD >/dev/null 2>&1; then echo __CLONED__; fi; ls -A 2>/dev/null`,
      ).catch(() => null);
      if (!probe) {
        if (++failures >= CLONE_MAX_CONSECUTIVE_FAILURES) break;
        await sleep(CLONE_POLL_MS);
        continue;
      }
      failures = 0;
      const result = parseRepoProbe(probe.stdout);
      if (result.cloned && result.listing === previous) {
        cloned = true;
        listing = result.listing;
        break;
      }
      previous = result.cloned ? result.listing : null;
      await sleep(CLONE_POLL_MS);
    }

    if (cloned) {
      await podBash(
        provider,
        record.sandboxHandle,
        threadId,
        GH_AUTH_COMMAND,
      ).catch((err) =>
        console.warn("[TASK_ADD_REPO] gh auth setup failed", err),
      );
    }

    return {
      success: cloned,
      repo: `${repo.owner}/${repo.repo}`,
      cloned,
      files: listing,
      message: cloned
        ? isPrimary
          ? `${repo.owner}/${repo.repo} is checked out at your working directory on branch ${gitRef}. \`git\` and \`gh\` are authenticated. Start working.`
          : `${repo.owner}/${repo.repo} is checked out at ../repos/${secondaryDirName}, beside your working directory, on its default branch. \`git\` and \`gh\` are authenticated there too. Your first checkout is untouched — commit and open a pull request in each repository you change.`
        : `The clone of ${repo.owner}/${repo.repo} did not finish within ${Math.round(
            CLONE_TIMEOUT_MS / 1000,
          )}s. It may still be in progress — check your working directory before calling this again.`,
    };
  },
});
