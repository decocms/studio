import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/mesh-context";
import { findContextRepo } from "./helpers";

export const CONTEXT_ISSUE_GET = defineTool({
  name: "CONTEXT_ISSUE_GET",
  description: "Get a GitHub issue with its comments from the context repo.",
  annotations: {
    title: "Get Context Issue",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    number: z.number().int().positive().describe("Issue number"),
  }),
  outputSchema: z.object({
    number: z.number(),
    title: z.string(),
    body: z.string(),
    state: z.string(),
    labels: z.array(z.string()),
    author: z.string(),
    createdAt: z.string(),
    comments: z.array(
      z.object({
        author: z.string(),
        body: z.string(),
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

    const proc = Bun.spawn(
      [
        "gh",
        "issue",
        "view",
        String(input.number),
        "--repo",
        `${config.owner}/${config.repo}`,
        "--json",
        "number,title,body,state,labels,author,comments,createdAt",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to get issue #${input.number}: ${stderr.trim()}`);
    }

    const raw = JSON.parse(stdout) as {
      number: number;
      title: string;
      body: string;
      state: string;
      labels: Array<{ name: string }>;
      author: { login: string };
      comments: Array<{
        author: { login: string };
        body: string;
        createdAt: string;
      }>;
      createdAt: string;
    };

    return {
      number: raw.number,
      title: raw.title,
      body: raw.body || "",
      state: raw.state,
      labels: raw.labels.map((l) => l.name),
      author: raw.author.login,
      createdAt: raw.createdAt,
      comments: raw.comments.map((c) => ({
        author: c.author.login,
        body: c.body,
        createdAt: c.createdAt,
      })),
    };
  },
});
