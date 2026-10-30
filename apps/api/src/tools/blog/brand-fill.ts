import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { blogJobStarter } from "./blog-job";
import { resolveBlogScope } from "./state";
import { openBlogJobChat } from "./super-agent-turn";

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
    const userId = blogJobStarter(ctx, "a brand fill");
    const threadId = await openBlogJobChat(ctx, {
      organizationId,
      userId,
      job: { kind: "brand-fill", brand },
      title: input.prompt.split("\n")[0]?.trim() || brand,
      text: input.prompt,
    });
    return { threadId };
  },
});
