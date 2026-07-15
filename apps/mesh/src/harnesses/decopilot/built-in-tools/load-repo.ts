/**
 * `load_repo` built-in — switch the calling agent's active GitHub repository.
 *
 * The agent's repo binding lives at `virtualMcp.metadata.githubRepo`, and the
 * sandbox that runs it is derived from `(orgId, virtualMcpId, branch)` — not the
 * repo. So switching repos means: rewrite `githubRepo`, then tear the current
 * sandbox down so the next file/bash tool call re-provisions a fresh sandbox
 * that clones the newly selected repo.
 *
 * The tool DESCRIPTION is built dynamically at `buildAllTools` time from the
 * org's imported repos (active `mcp-github` connections carrying a
 * `repoScope` recipe), so the model learns which repos exist just by reading
 * the tool — no extra listing round-trip.
 *
 * CLUSTER-GLUE: `@/`-coupled (storage + sandbox provisioning), same tier as
 * `cluster-sandbox-fs.ts`.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { StudioContext } from "@/core/studio-context";
import { resolveSandboxProvider } from "@/sandbox/resolve-provider";
import { getRepoScope } from "@/shared/github-repo-scope";
import { SANDBOX_DELETE } from "@/tools/sandbox/delete";
import type { VirtualMCPUpdateData } from "@/tools/virtual/schema";

type RepoOption = {
  connectionId: string;
  owner: string;
  repo: string;
  installationId: number;
};

/**
 * List the org's imported repos: active `mcp-github` connections that carry a
 * `repoScope` recipe (per-agent import children AND org-shared "Add repo"
 * connections both qualify — both are repo-scoped).
 */
export async function listOrgRepos(
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
    "Load a GitHub repository into this agent's sandbox so the file tools " +
    "(read/write/edit/bash/grep/glob) and dev server operate on that repo. " +
    "Calling this switches the active repo: it stops the current sandbox and " +
    "the next file/bash tool call boots a fresh sandbox that clones the " +
    "selected repo — the switch takes effect on the following message.";
  if (repos.length === 0) {
    return `${base} No repositories have been imported into this organization yet; import one from the app first.`;
  }
  const list = repos
    .map((r) => `- ${r.owner}/${r.repo} (connectionId: ${r.connectionId})`)
    .join("\n");
  return `${base}\n\nRepositories imported into this organization:\n${list}\n\nPass the connectionId of the repo to load.`;
}

export async function createLoadRepoTool(opts: {
  ctx: StudioContext;
  orgId: string;
  virtualMcpId: string;
  branch: string;
  userId: string;
}) {
  const { ctx, orgId, virtualMcpId, branch, userId } = opts;
  const repos = await listOrgRepos(ctx, orgId);
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

      // 1. Switch the agent's repo binding.
      const vm = await ctx.storage.virtualMcps.findById(virtualMcpId);
      if (!vm) return { success: false, error: "Agent not found." };
      const meta = (vm.metadata ?? {}) as Record<string, unknown>;
      await ctx.storage.virtualMcps.update(virtualMcpId, userId, {
        metadata: {
          ...meta,
          githubRepo: {
            url: `https://github.com/${repo.owner}/${repo.repo}`,
            owner: repo.owner,
            name: repo.repo,
            installationId: repo.installationId,
            connectionId: repo.connectionId,
          },
        } as VirtualMCPUpdateData["metadata"],
      });

      // 2. Tear down the current sandbox so the next fs call re-provisions with
      //    the new repo. Resolve the provider kind so SANDBOX_DELETE locates the
      //    right sandboxMap entry.
      const { kind } = await resolveSandboxProvider(ctx, {
        userId,
        branch,
        virtualMcpMetadata: meta,
      });
      await SANDBOX_DELETE.execute(
        { virtualMcpId, branch, sandboxProviderKind: kind },
        ctx,
      );

      return {
        success: true,
        repo: `${repo.owner}/${repo.repo}`,
        message: `Loaded ${repo.owner}/${repo.repo}. The sandbox was reset; the next file or bash tool call will boot a fresh sandbox for this repo.`,
      };
    },
  });
}
