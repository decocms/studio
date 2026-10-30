import { BRAND_FILL_THREAD_KEY } from "@decocms/shared/brand";
import { getDecopilotId } from "@decocms/shared/sdk";
import { z } from "zod";
import { agentSandboxEnabled } from "@/settings";
import { threadBranch } from "@/tools/sandbox/thread-repo";
import { defineTool } from "../../core/define-tool";
import { getUserId } from "../../core/studio-context";
import { callerRunThread } from "./cards";
import { resolveBlogScope } from "./state";
import { dispatchSuperAgentTurn } from "./super-agent-turn";

/**
 * A brand guide's fill, in a chat of its own.
 *
 * A chat a person types reaches only the connections its agent aggregates, and
 * the Super Agent aggregates none of the store's: a fill asked from the side
 * panel read the site and its repository, never what customers search for or
 * buy. Started here, the chat is marked as a brand fill, and dispatch gives it
 * the blog's connections, read-only, as it gives a card's chat.
 */

const MAX_PROMPT_CHARS = 4_000;
const MAX_TITLE_CHARS = 120;

export const BLOG_BRAND_FILL = defineTool({
  name: "BLOG_BRAND_FILL",
  description:
    "Start the brand skill's fill of the organization's brand guide in a chat of its own, one that may read the store's VTEX, GA4 and Search Console. Returns the chat; the guide fills as its agent writes it.",
  annotations: {
    title: "Fill the Brand Guide",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },

  inputSchema: z.object({
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(MAX_PROMPT_CHARS)
      .describe(
        "The ask, in the person's own words and language: which guide, from where, filling what.",
      ),
  }),

  outputSchema: z.object({
    threadId: z.string().describe("The fill's chat, to open beside the page."),
  }),

  handler: async (input, ctx) => {
    const { organizationId, brand } = await resolveBlogScope(ctx);
    if (callerRunThread(ctx)) {
      throw new Error("A run cannot start a brand fill; a person does.");
    }
    if (!agentSandboxEnabled()) {
      throw new Error(
        "A brand fill runs in a sandbox, and this deployment has none.",
      );
    }
    const userId = getUserId(ctx);
    if (!userId) throw new Error("A brand fill needs a person to belong to.");

    const threadId = crypto.randomUUID();
    const branch = threadBranch(threadId);
    const line = input.prompt.split("\n")[0]?.trim() || brand;
    await ctx.storage.threads.create({
      id: threadId,
      organization_id: organizationId,
      title:
        line.length > MAX_TITLE_CHARS
          ? `${line.slice(0, MAX_TITLE_CHARS - 1)}…`
          : line,
      status: "in_progress",
      virtual_mcp_id: getDecopilotId(organizationId),
      // The terminal writer skips v1 threads, so a v1 run never ends.
      message_storage_version: 2,
      harness_id: "claude-code",
      created_by: userId,
      branch,
      metadata: { runtime: "sandbox", [BRAND_FILL_THREAD_KEY]: { brand } },
    });

    try {
      await dispatchSuperAgentTurn(ctx, {
        organizationId,
        userId,
        threadId,
        branch,
        text: input.prompt,
        fence: `brand-fill:${threadId}`,
        requestedAt: new Date().toISOString(),
      });
    } catch (err) {
      await ctx.storage.threads
        .delete(threadId)
        .catch((cleanup) =>
          console.error("[blog] brand fill chat cleanup failed", cleanup),
        );
      throw err;
    }
    return { threadId };
  },
});
