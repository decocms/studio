import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/mesh-context";
import { findContextRepo } from "./helpers";

export const CONTEXT_ISSUE_CREATE = defineTool({
  name: "CONTEXT_ISSUE_CREATE",
  description:
    "Create a GitHub issue in the context repo. Use this to report findings, problems, or share information with the team.",
  annotations: {
    title: "Create Context Issue",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    title: z.string().min(1).max(256).describe("Issue title"),
    body: z.string().min(1).describe("Issue body (markdown)"),
    labels: z.array(z.string()).optional().describe("Labels to apply"),
  }),
  outputSchema: z.object({
    number: z.number(),
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
    const footer = `\n\n---\n_Created by ${agentName} via Deco Mesh_`;
    const fullBody = input.body + footer;

    const args = [
      "gh",
      "issue",
      "create",
      "--repo",
      `${config.owner}/${config.repo}`,
      "--title",
      input.title,
      "--body",
      fullBody,
    ];
    if (input.labels?.length) {
      for (const label of input.labels) {
        args.push("--label", label);
      }
    }

    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`Failed to create issue: ${stderr.trim()}`);
    }

    const url = stdout.trim();
    const numberMatch = url.match(/\/issues\/(\d+)/);
    const number = numberMatch ? parseInt(numberMatch[1]!, 10) : 0;

    return { number, url };
  },
});
