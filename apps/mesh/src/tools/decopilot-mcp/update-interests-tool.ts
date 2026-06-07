/**
 * Cluster-side MCP exposure of the `update_interests` decopilot built-in.
 *
 * The desktop daemon calls this via the injected `mcp.url` token instead of
 * running it in-process (which would require `ctx.storage.interests`).
 * In-cluster decopilot continues to use the built-in directly (no MCP round-trip).
 *
 * Registered in `tools/index.ts` CORE_TOOLS so it appears on the management
 * MCP server (reachable via the `{orgId}_self` connection). When the desktop
 * daemon's `toolsFromMCP()` calls `listTools()` on the virtual-MCP endpoint,
 * this tool is returned alongside all other management tools.
 */
import { z } from "zod";
import { defineTool } from "@/core/define-tool";

const UpdateInterestsInputSchema = z.object({
  interests: z
    .array(
      z.object({
        title: z
          .string()
          .max(120)
          .describe("Short noun phrase, e.g. 'Learning Rust'"),
        summary: z
          .string()
          .max(500)
          .describe("One or two sentences of context, including any progress"),
      }),
    )
    .max(10),
  agentId: z
    .string()
    .min(1)
    .max(128)
    .describe("Agent (Virtual MCP) id scoping these interests."),
  userId: z.string().min(1).describe("User id scoping these interests."),
});

export const UPDATE_INTERESTS_MCP = defineTool({
  name: "UPDATE_INTERESTS_MCP" as const,
  description:
    "Record what the user is durably working toward (their goals/interests). " +
    "Pass the FULL list every time — it replaces the stored one. Order by importance, most first.",
  inputSchema: UpdateInterestsInputSchema,
  outputSchema: z.object({ ok: z.literal(true), count: z.number() }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const organization = ctx.organization;
    if (!organization) throw new Error("Organization context required");
    await ctx.storage.interests.setForAgent(
      organization.id,
      input.agentId,
      input.userId,
      { interests: input.interests },
    );
    return { ok: true as const, count: input.interests.length };
  },
});
