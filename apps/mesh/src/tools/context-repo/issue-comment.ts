import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/mesh-context";
import { findContextRepo } from "./helpers";

export const CONTEXT_ISSUE_COMMENT = defineTool({
  name: "CONTEXT_ISSUE_COMMENT",
  description: "Add a comment to a GitHub issue in the context repo.",
  annotations: {
    title: "Comment on Context Issue",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    number: z.number().int().positive().describe("Issue number"),
    body: z.string().min(1).describe("Comment body (markdown)"),
  }),
  outputSchema: z.object({
    url: z.string(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const orgId = ctx.organization?.id;
    if (!orgId) throw new Error("Organization required");

    const config = await findContextRepo(ctx);
    if (!config) throw new Error("No context repo configured.");

    const agentName = ctx.auth.user?.name || "Decopilot";
    const footer = `\n\n---\n_Comment by ${agentName} via Deco Mesh_`;
    const fullBody = input.body + footer;

    const proc = Bun.spawn(
      [
        "gh",
        "issue",
        "comment",
        String(input.number),
        "--repo",
        `${config.owner}/${config.repo}`,
        "--body",
        fullBody,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `Failed to comment on issue #${input.number}: ${stderr.trim()}`,
      );
    }

    return {
      url:
        stdout.trim() ||
        `https://github.com/${config.owner}/${config.repo}/issues/${input.number}`,
    };
  },
});
