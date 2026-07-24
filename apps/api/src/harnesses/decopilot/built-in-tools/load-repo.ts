/**
 * `load_repo` built-in — bind a GitHub repository to the current conversation.
 *
 * Why thread-scoped: the Decopilot super-agent (the common caller) is a
 * SYNTHETIC virtual MCP — `virtualMcps.findById` returns an in-memory object
 * with no `connections` row, so a repo can't be persisted on the agent and its
 * sandbox branch is the shared, repo-less `"ephemeral"`. Instead we bind the
 * repo to the THREAD (`threads.metadata.githubRepo` + a dedicated
 * `thread:<id>` branch — real, persisted columns). Sandbox provisioning
 * (`ensureSandbox`) and the fs-tool binding (`tools.ts`) both prefer the
 * thread's repo, so the thread gets its own repo-cloned sandbox. For real
 * repo-agents this is a per-conversation override.
 *
 * The tool clones EAGERLY and waits: it provisions the repo sandbox and blocks
 * until the git checkout is present before returning, then signals the client
 * to open the Preview panel. Once the clone is confirmed it re-points the run's
 * live VM file tools at the new sandbox branch (`rebindFs`), so the model can
 * read/edit/bash the repo in the SAME turn — without this the tools stay bound
 * to the turn-start branch and only pick up the repo on the next message, which
 * an autonomous single-turn run (e.g. a delegated task) never sends, so it
 * loops on an empty `/app/repo`. The returned root listing lets the model
 * confirm the repo without a same-turn `bash`.
 *
 * CLUSTER-GLUE: `@/`-coupled, same tier as `cluster-sandbox-fs.ts`.
 */

import { sleep } from "@decocms/shared/std";
import { tool, zodSchema, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import { resolveSandboxProvider } from "@/sandbox/resolve-provider";
import { getRepoScope } from "@decocms/shared/github-repo-scope";
import {
  mergeSandboxMapEntry,
  readSandboxMap,
} from "@/tools/sandbox/sandbox-map";
import { ensureSandbox } from "@/tools/sandbox/start";
import { threadBranch } from "@/tools/sandbox/thread-repo";
import { buildClusterSandboxFs } from "./cluster-sandbox-fs";

type RepoOption = {
  connectionId: string;
  owner: string;
  repo: string;
  installationId: number;
};

/** Minimal connection shape the repo selection needs (keeps the pure helper
 *  testable without the full `ConnectionEntity`). */
type RepoConnection = {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
};

/** Wait at most this long for the clone to land before returning anyway. */
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_POLL_MS = 1_500;
/** Give up early if the sandbox can't answer the probe at all this many times
 *  in a row (a broken/partitioned runner) — no point polling a dead link for
 *  the full timeout. */
const CLONE_MAX_CONSECUTIVE_FAILURES = 5;

/**
 * The repos `load_repo` offers: every active `mcp-github` connection carrying a
 * `repoScope` — i.e. each repo imported into the org (the "Code Agents" list in
 * the UI). This includes both org-shared imports and per-agent imports; they're
 * all the user's own org repos and all loadable. The base org-level `mcp-github`
 * connection has no `repoScope`, so it's skipped. Pure so it's unit-testable.
 */
export function selectLoadableRepos(
  connections: RepoConnection[],
): RepoOption[] {
  const repos: RepoOption[] = [];
  for (const conn of connections) {
    if (conn.status !== "active") continue;
    const scope = getRepoScope(conn);
    if (!scope) continue;
    repos.push({
      connectionId: conn.id,
      owner: scope.owner,
      repo: scope.repo,
      installationId: scope.installationId,
    });
  }
  return repos;
}

async function listOrgRepos(
  ctx: StudioContext,
  orgId: string,
): Promise<RepoOption[]> {
  const { items } = await ctx.storage.connections.list(orgId, {
    slug: "mcp-github",
  });
  return selectLoadableRepos(items);
}

/**
 * Interpret the clone-probe stdout (`echo __CLONED__` HEAD marker + `ls -A`).
 * `cloned` requires actual working-tree entries — a HEAD ref (the `__CLONED__`
 * marker) can appear BEFORE the checkout lands on a lagging sandbox FS, so
 * HEAD alone is NOT "ready" (that false-positive returned success with an empty
 * `/app/repo`, and the agent's first grep/read hit "No such file or directory").
 * The listing is the repo root minus `.git`; the caller additionally waits for
 * it to STABILIZE across polls to survive a progressive checkout. Pure so it's
 * unit-testable.
 */
export function parseCloneProbe(stdout: string): {
  cloned: boolean;
  listing: string;
} {
  const entries = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== ".git" && l !== "__CLONED__");
  const cloned = entries.length > 0;
  return { cloned, listing: cloned ? entries.join("\n") : "" };
}

export function buildDescription(repos: RepoOption[]): string {
  const base =
    "Load a GitHub repository into this conversation's sandbox so the file " +
    "tools (read/write/edit/bash/grep/glob) and dev server operate on that " +
    "repo, and open its live Preview. Waits until the repo is cloned before " +
    "returning. Calling it again switches the repo. File tools operate on the " +
    "loaded repo from your NEXT message (this turn's tools are still bound to " +
    "the previous workspace), so after loading, prefer the file listing this " +
    "tool returns over re-running bash in the same turn.";
  const list = repos
    .map((r) => `- ${r.owner}/${r.repo} (connectionId: ${r.connectionId})`)
    .join("\n");
  return `${base}\n\nRepositories imported into this organization:\n${list}\n\nPass the connectionId of the repo to load.`;
}

export async function createLoadRepoTool(opts: {
  ctx: StudioContext;
  orgId: string;
  virtualMcpId: string;
  userId: string;
  threadId: string;
  writer: UIMessageStreamWriter;
  /**
   * Re-point the run's live VM file tools at the sandbox branch this load
   * provisioned, so the model can use the repo in the SAME turn. Called once
   * the checkout is confirmed present. Omitted in contexts with no swappable
   * fs (tests) — then the legacy "next message" binding still applies.
   */
  rebindFs?: (branch: string) => Promise<void>;
}) {
  const { ctx, orgId, virtualMcpId, userId, threadId, writer, rebindFs } = opts;
  const repos = await listOrgRepos(ctx, orgId);
  // Nothing to switch between — don't expose the tool at all.
  if (repos.length === 0) return null;
  const byConnId = new Map(repos.map((r) => [r.connectionId, r]));

  return tool({
    description: buildDescription(repos),
    inputSchema: zodSchema(
      z.object({
        connectionId: z
          .string()
          .describe(
            "connectionId of the imported repository to load (see the list in this tool's description).",
          ),
      }),
    ),
    execute: async ({ connectionId }: { connectionId: string }) => {
      const repo = byConnId.get(connectionId);
      if (!repo) {
        return {
          success: false,
          error: `No imported repository found for connectionId "${connectionId}". Available: ${
            repos.map((r) => r.connectionId).join(", ") || "none"
          }.`,
        };
      }

      // Branch is repo-specific (includes the connection id) so switching repos
      // yields a distinct sandbox + previewUrl — that's what makes the preview
      // UI react to a switch, and it sidesteps stale-checkout entirely (each
      // repo gets its own sandbox; re-loading one adopts its existing sandbox).
      const branch = threadBranch(threadId, repo.connectionId);
      const githubRepo = {
        url: `https://github.com/${repo.owner}/${repo.repo}`,
        owner: repo.owner,
        name: repo.repo,
        installationId: repo.installationId,
        connectionId: repo.connectionId,
      };

      // 1. Bind the repo to the thread (the only place it persists for the
      //    synthetic Decopilot agent). Merge into existing metadata.
      const thread = await ctx.storage.threads.get(threadId);
      await ctx.storage.threads.update(threadId, {
        metadata: { ...(thread?.metadata ?? {}), githubRepo },
        branch,
        updated_by: userId,
      });

      // 2. Eagerly provision the repo sandbox on the repo-specific branch.
      //    `ensureSandbox` reads the thread repo we just wrote (it prefers
      //    thread over agent). Resolve the kind so the frontend + fs tools bind
      //    to the same sandbox.
      const { kind } = await resolveSandboxProvider(ctx, {
        userId,
        branch,
        virtualMcpId,
        virtualMcpMetadata: null,
      });
      const entry = await ensureSandbox(
        { virtualMcpId, branch, sandboxProviderKind: kind },
        ctx,
      );

      // 3. `ensureSandbox` already persisted the sandbox record on the thread
      //    (provisionSandbox → setThreadSandboxMapEntry — the single writer), so
      //    we don't re-write it: a second write from the pre-provision snapshot
      //    would clobber a sibling repo's entry when switching repos. We only
      //    open the Preview NOW — before the (up-to-2min) clone poll — so it
      //    renders its booting state immediately and survives an interrupted
      //    turn. `previewUrl` is known the moment `ensureSandbox` returns.
      //    Send the merged map (snapshot + this entry, via the shared helper) so
      //    the client patches its local thread without dropping sibling repos.
      const sandboxMap = mergeSandboxMapEntry(
        readSandboxMap(thread?.metadata),
        userId,
        branch,
        kind,
        entry,
      );
      // Open the Preview panel + patch the client's local thread row (branch +
      // repo + sandbox) so `activeTask` reflects the switch without a refetch
      // (mirrors the `data-deck-updated` path).
      writer.write({
        type: "data-open-preview",
        id: threadId,
        data: {
          previewUrl: entry.previewUrl ?? null,
          branch,
          githubRepo,
          sandboxMap,
          sandboxProviderKind: kind,
        },
      } as Parameters<UIMessageStreamWriter["write"]>[0]);

      // 4. Poll until the checkout is present, only to enrich the return
      //    message/listing. Provisioning starts the clone async in the daemon,
      //    so `ensureSandbox` returning isn't proof the files are there.
      const fs = await buildClusterSandboxFs(ctx, {
        virtualMcpId,
        branch,
        userId,
      });
      const deadline = Date.now() + CLONE_TIMEOUT_MS;
      let listing = "";
      let cloned = false;
      let consecutiveFailures = 0;
      // A lagging clone reveals the working tree progressively, so a single
      // non-empty listing can still be mid-checkout (more files land the next
      // second). Require the listing to STABILIZE — two consecutive identical
      // non-empty probes — before declaring the repo ready.
      let lastListing: string | null = null;
      while (Date.now() < deadline) {
        const probe = await fs
          .onBash(
            "if git -C /app/repo rev-parse HEAD >/dev/null 2>&1; then echo __CLONED__; fi; ls -A /app/repo 2>/dev/null",
          )
          .then((r) => ({ ok: true as const, stdout: r.stdout }))
          .catch(() => ({ ok: false as const, stdout: "" }));
        if (!probe.ok) {
          // The runner itself couldn't answer — a dead/partitioned link won't
          // recover mid-poll, so bail instead of burning the full timeout.
          if (++consecutiveFailures >= CLONE_MAX_CONSECUTIVE_FAILURES) break;
          await sleep(CLONE_POLL_MS);
          continue;
        }
        consecutiveFailures = 0;
        const result = parseCloneProbe(probe.stdout);
        if (result.cloned && result.listing === lastListing) {
          cloned = true;
          listing = result.listing;
          break;
        }
        lastListing = result.cloned ? result.listing : null;
        await sleep(CLONE_POLL_MS);
      }

      // Re-point the run's live VM file tools at this repo's sandbox so the
      // model can read/edit/bash it in the SAME turn. Only after the clone is
      // confirmed present — swapping earlier would bind the tools to an empty
      // checkout and reproduce the original loop. Best-effort: a rebind failure
      // just falls back to the next-message binding, so never fail the load.
      let reboundThisTurn = false;
      if (cloned && rebindFs) {
        try {
          await rebindFs(branch);
          reboundThisTurn = true;
        } catch (err) {
          console.warn("[load_repo] live fs rebind failed", err);
        }
      }

      return {
        success: true,
        repo: `${repo.owner}/${repo.repo}`,
        previewUrl: entry.previewUrl ?? null,
        cloned,
        files: listing,
        message: !cloned
          ? `Loaded ${repo.owner}/${repo.repo} and opened the Preview, but the clone did not finish within ${Math.round(
              CLONE_TIMEOUT_MS / 1000,
            )}s. It may still be in progress — your file tools will use it next message.`
          : reboundThisTurn
            ? `Loaded ${repo.owner}/${repo.repo} and opened the Preview. The repo is cloned and its dev server is booting. Your file tools (read/write/edit/bash/grep/glob) now operate on it — you can use it right away.`
            : `Loaded ${repo.owner}/${repo.repo} and opened the Preview. The repo is cloned and its dev server is booting. Your file tools operate on it from your next message.`,
      };
    },
  });
}
