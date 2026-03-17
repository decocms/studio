/**
 * SKILL_REGISTRY_SYNC Tool
 *
 * Clones or updates a GitHub repository locally for skill/agent browsing.
 * Repos are stored in {DATA_DIR}/repos/{owner}/{repo}/.
 */

import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";
import { env } from "../../env";

const InputSchema = z.object({
  owner: z.string().describe("GitHub repository owner"),
  repo: z.string().describe("GitHub repository name"),
});

const OutputSchema = z.object({
  path: z.string().describe("Local path of the cloned repository"),
  status: z
    .enum(["cloned", "updated", "unchanged"])
    .describe("What happened during sync"),
});

function reposDir(): string {
  return join(env.DATA_DIR, "repos");
}

export function repoPath(owner: string, repo: string): string {
  return join(reposDir(), owner, repo);
}

export const SKILL_REGISTRY_SYNC = defineTool({
  name: "SKILL_REGISTRY_SYNC",
  description:
    "Clone or update a GitHub repository for browsing skills and agents. Repos are stored locally in the data directory.",
  annotations: {
    title: "Sync Skill Registry",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: InputSchema,
  outputSchema: OutputSchema,

  handler: async (
    input,
    ctx,
  ): Promise<{
    path: string;
    status: "cloned" | "updated" | "unchanged";
  }> => {
    requireAuth(ctx);
    await ctx.access.check();

    const localPath = repoPath(input.owner, input.repo);
    const repoUrl = `https://github.com/${input.owner}/${input.repo}.git`;

    if (existsSync(join(localPath, ".git"))) {
      // Already cloned — pull latest
      const proc = Bun.spawn(["git", "pull", "--ff-only"], {
        cwd: localPath,
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;

      const stdout = await new Response(proc.stdout).text();
      const status: "updated" | "unchanged" = stdout.includes(
        "Already up to date",
      )
        ? "unchanged"
        : "updated";

      return { path: localPath, status };
    }

    // Fresh clone (shallow for speed)
    const proc = Bun.spawn(
      ["git", "clone", "--depth", "1", repoUrl, localPath],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `Failed to clone ${input.owner}/${input.repo}: ${stderr.trim()}`,
      );
    }

    return { path: localPath, status: "cloned" };
  },
});
