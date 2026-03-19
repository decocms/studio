import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/mesh-context";
import { findContextRepo, getContextRepoPath } from "./helpers";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export const CONTEXT_AGENT_SAVE = defineTool({
  name: "CONTEXT_AGENT_SAVE",
  description:
    "Save an agent definition to the context repo as agents/<name>.md and open a PR.",
  annotations: {
    title: "Save Agent to Context Repo",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    agentId: z.string().describe("Virtual MCP (agent) ID"),
    commitMessage: z.string().optional().describe("Custom commit message"),
  }),
  outputSchema: z.object({
    prUrl: z.string(),
    branch: z.string(),
    path: z.string(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const orgId = ctx.organization?.id;
    if (!orgId) throw new Error("Organization required");

    const config = await findContextRepo(ctx);
    if (!config) throw new Error("No context repo configured.");

    // Load agent connection
    const connections = await ctx.storage.connections.list(orgId, {
      includeVirtual: true,
    });
    const agentConn = connections.find(
      (c) => c.id === input.agentId && c.connection_type === "VIRTUAL",
    );
    if (!agentConn) throw new Error(`Agent not found: ${input.agentId}`);

    const agentMeta =
      typeof agentConn.metadata === "string"
        ? JSON.parse(agentConn.metadata || "{}")
        : ((agentConn.metadata || {}) as Record<string, unknown>);
    const instructions =
      (agentMeta as { instructions?: string }).instructions || "";

    const title = agentConn.title || "Unnamed Agent";
    const description = agentConn.description || "";
    const icon = agentConn.icon || "";
    const slug = slugify(title);

    // Build markdown
    const lines = ["---", `name: ${title}`, `description: ${description}`];
    if (icon) lines.push(`icon: ${icon}`);
    if (instructions) {
      lines.push("instructions: |");
      for (const line of instructions.split("\n")) {
        lines.push(`  ${line}`);
      }
    }
    lines.push("---");
    lines.push("");
    lines.push(`# ${title}`);
    lines.push("");
    if (description) {
      lines.push(description);
      lines.push("");
    }

    const markdown = lines.join("\n");
    const repoPath = getContextRepoPath(orgId, config.owner, config.repo);
    const filePath = `agents/${slug}.md`;
    const fullFilePath = join(repoPath, filePath);

    mkdirSync(join(repoPath, "agents"), { recursive: true });
    writeFileSync(fullFilePath, markdown, "utf-8");

    const branchName = `agent/${slug}-${Date.now()}`;
    const message = input.commitMessage || `Update agent: ${title}`;

    const git = (args: string[]) =>
      Bun.spawn(["git", "-C", repoPath, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });

    await git(["checkout", "-b", branchName]).exited;
    await git(["add", filePath]).exited;
    await git(["commit", "-m", message]).exited;
    await git(["push", "-u", "origin", branchName]).exited;

    // Switch back to tracked branch
    await git(["checkout", config.branch]).exited;

    const prProc = Bun.spawn(
      [
        "gh",
        "pr",
        "create",
        "--repo",
        `${config.owner}/${config.repo}`,
        "--head",
        branchName,
        "--title",
        message,
        "--body",
        `Saves agent **${title}** definition to \`${filePath}\`.\n\nCreated via Deco Mesh.`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const prUrl = (await new Response(prProc.stdout).text()).trim();
    const prExit = await prProc.exited;

    if (prExit !== 0) {
      const stderr = await new Response(prProc.stderr).text();
      throw new Error(`Failed to create PR: ${stderr.trim()}`);
    }

    return { prUrl, branch: branchName, path: filePath };
  },
});
