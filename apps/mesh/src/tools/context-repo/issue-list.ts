import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/mesh-context";
import { findContextRepo } from "./helpers";

export const CONTEXT_ISSUE_LIST = defineTool({
  name: "CONTEXT_ISSUE_LIST",
  description: "List or search GitHub issues in the context repo.",
  annotations: {
    title: "List Context Issues",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    state: z
      .enum(["open", "closed", "all"])
      .default("open")
      .describe("Issue state filter"),
    labels: z
      .string()
      .optional()
      .describe("Comma-separated labels to filter by"),
    query: z.string().optional().describe("Search query"),
    limit: z.number().min(1).max(100).default(30).describe("Max results"),
  }),
  outputSchema: z.object({
    issues: z.array(
      z.object({
        number: z.number(),
        title: z.string(),
        state: z.string(),
        labels: z.array(z.string()),
        author: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const orgId = ctx.organization?.id;
    if (!orgId) throw new Error("Organization required");

    const config = await findContextRepo(ctx);
    if (!config) throw new Error("No context repo configured.");

    const args = [
      "gh",
      "issue",
      "list",
      "--repo",
      `${config.owner}/${config.repo}`,
      "--json",
      "number,title,state,labels,author,createdAt",
      "--state",
      input.state,
      "--limit",
      String(input.limit),
    ];
    if (input.labels) args.push("--label", input.labels);
    if (input.query) args.push("--search", input.query);

    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to list issues: ${stderr.trim()}`);
    }

    const raw = JSON.parse(stdout || "[]") as Array<{
      number: number;
      title: string;
      state: string;
      labels: Array<{ name: string }>;
      author: { login: string };
      createdAt: string;
    }>;

    return {
      issues: raw.map((issue) => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels: issue.labels.map((l) => l.name),
        author: issue.author.login,
        createdAt: issue.createdAt,
      })),
    };
  },
});
