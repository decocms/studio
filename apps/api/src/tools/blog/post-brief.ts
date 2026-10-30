import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { requireBlogAi } from "./feature-flag";
import { agentWritingBrief, WritingInputSchema } from "./post-draft";

/**
 * The writing brief for an agent that writes a post itself.
 *
 * `BLOG_POST_DRAFT` writes with the organization's model, so a card's Claude
 * Code, on the person's own plan, had only that model to write with. This
 * hands it what that model reads instead: the same rules, the same reading of
 * the brand, campaign and blocks, and what the store said. The agent writes,
 * and `BLOG_POST_ASSEMBLE` checks each section against its block's schema.
 */

/** What the store's systems said, as the agent gathered it. */
const MAX_GROUNDING_CHARS = 20_000;

export const BLOG_POST_BRIEF = defineTool({
  name: "BLOG_POST_BRIEF",
  description:
    "The brief for writing one blog post yourself: the brand's voice and rules, the campaign, the format, the site's blocks with their schemas, and the store data you pass in, then the JSON shape to answer in. Spends no model. Pass what you write to BLOG_POST_ASSEMBLE as `draft`.",
  annotations: {
    title: "Brief a Blog Post",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  inputSchema: WritingInputSchema.extend({
    grounding: z
      .string()
      .max(MAX_GROUNDING_CHARS)
      .default("")
      .describe(
        "What the store's systems said, as you gathered it: each figure exactly as its tool reported it, with the tool's name.",
      ),
  }),

  outputSchema: z.object({
    brief: z
      .string()
      .describe("Read it whole, then write the post it asks for."),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    await requireBlogAi(ctx, organization.id);
    return { brief: agentWritingBrief(input, input.grounding) };
  },
});
