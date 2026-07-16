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
 * to open the Preview panel. File tools the model calls in the SAME turn are
 * still bound to the pre-load branch (the turn's binding is fixed at
 * turn-start); they pick up the repo from the next message — by which point the
 * eager clone has it hot. The returned root listing lets the model confirm the
 * repo without a same-turn `bash`.
 *
 * CLUSTER-GLUE: `@/`-coupled, same tier as `cluster-sandbox-fs.ts`.
 */

import { sleep } from "@decocms/std";
import { tool, zodSchema, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import { resolveSandboxProvider } from "@/sandbox/resolve-provider";
import { getRepoScope } from "@/shared/github-repo-scope";
import { ensureSandbox } from "@/tools/sandbox/start";
import { threadBranch } from "@/tools/sandbox/thread-repo";
import { buildClusterSandboxFs } from "./cluster-sandbox-fs";

type RepoOption = {
  connectionId: string;
  owner: string;
  repo: string;
  installationId: number;
};

/** Wait at most this long for the clone to land before returning anyway. */
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_POLL_MS = 1_500;

async function listOrgRepos(
  ctx: StudioContext,
  orgId: string,
): Promise<RepoOption[]> {
  const { items } = await ctx.storage.connections.list(orgId, {
    slug: "mcp-github",
  });
  const repos: RepoOption[] = [];
  for (const conn of items) {
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
}) {
  const { ctx, orgId, virtualMcpId, userId, threadId, writer } = opts;
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
        virtualMcpMetadata: null,
      });
      const entry = await ensureSandbox(
        { virtualMcpId, branch, sandboxProviderKind: kind },
        ctx,
      );

      // 3. Persist the sandbox record on the thread and open the Preview NOW —
      //    before the (up-to-2min) clone poll — so the preview renders its
      //    normal booting state immediately and survives an interrupted turn.
      //    `previewUrl` is known the moment `ensureSandbox` returns; the clone
      //    finishing is separate. The synthetic agent's sandboxMap never
      //    persists, so the frontend reads this thread-scoped entry instead,
      //    keyed the same 3-level way ([userId][branch][kind]).
      const sandboxMap = {
        [userId]: { [branch]: { [kind]: entry } },
      };
      await ctx.storage.threads.update(threadId, {
        metadata: { ...(thread?.metadata ?? {}), githubRepo, sandboxMap },
        updated_by: userId,
      });
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
      while (Date.now() < deadline) {
        const { stdout } = await fs
          .onBash(
            "if git -C /app/repo rev-parse HEAD >/dev/null 2>&1; then echo __CLONED__; fi; ls -A /app/repo 2>/dev/null",
          )
          .catch(() => ({ stdout: "" }) as { stdout: string });
        const entries = stdout
          .replace("__CLONED__\n", "")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && l !== ".git");
        if (stdout.includes("__CLONED__") || entries.length > 0) {
          cloned = true;
          listing = entries.join("\n");
          break;
        }
        await sleep(CLONE_POLL_MS);
      }

      return {
        success: true,
        repo: `${repo.owner}/${repo.repo}`,
        previewUrl: entry.previewUrl ?? null,
        cloned,
        files: listing,
        message: cloned
          ? `Loaded ${repo.owner}/${repo.repo} and opened the Preview. The repo is cloned and its dev server is booting. Your file tools operate on it from your next message.`
          : `Loaded ${repo.owner}/${repo.repo} and opened the Preview, but the clone did not finish within ${Math.round(
              CLONE_TIMEOUT_MS / 1000,
            )}s. It may still be in progress — your file tools will use it next message.`,
      };
    },
  });
}
