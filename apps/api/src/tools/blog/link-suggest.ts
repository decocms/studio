import { generateObject } from "ai";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { resolveTier } from "../../core/resolve-tier";

/**
 * One proposed internal link: a phrase that appears verbatim in the post body,
 * and the slug of an existing post it should link to. The caller validates both
 * ends (the quote must be found in the body, the slug must be a real post)
 * before applying — the model never emits a URL, so it cannot invent a link.
 */
const LinkSuggestionSchema = z.object({
  quote: z
    .string()
    .describe(
      "The exact phrase from the post body to turn into a link — a few words that appear VERBATIM in the text (same casing and accents). Not a paraphrase.",
    ),
  slug: z
    .string()
    .describe(
      "The slug of the existing post to link to — must be one of the candidate slugs given, never invented.",
    ),
});

/** Caps on what a client may send — the request body is a trust boundary. */
const MAX_BODY_CHARS = 40_000;
const MAX_POSTS = 500;
const MAX_TITLE_CHARS = 300;
const MAX_SLUG_CHARS = 300;

const SYSTEM = `You add internal links to a blog post: you connect phrases in the post to OTHER posts the site already published, the way an editor cross-links related reading. Good internal links help SEO (they tell search and AI engines how the site's pages relate) and keep the reader on the site.

Rules:

1. LINK ONLY TO THE POSTS YOU ARE GIVEN. You get a list of existing posts (title + slug). Every suggestion's \`slug\` must be one of them. Never invent a slug, and never link a post to itself.

2. THE QUOTE MUST BE VERBATIM. \`quote\` is the exact run of words from the body to wrap in the link — copy it character for character (same casing, same accents). If the phrase isn't in the body word for word, don't suggest it.

3. LINK THE PHRASE THAT MATCHES THE TARGET'S TOPIC. Link "produtos de couro" to the leather-products post, not a random word near it. The phrase should be what a reader would click expecting that post.

4. FEW AND STRONG. A handful of genuinely relevant links beats many weak ones. Skip a post if nothing in the body is really about it. Never link the same phrase twice, and prefer one link per target post.

Return only the links worth making. An empty list is a fine answer when the body doesn't relate to any existing post.`;

export const BLOG_LINK_SUGGEST = defineTool({
  name: "BLOG_LINK_SUGGEST",
  description:
    "Propose internal links for a blog post — phrases in its body to link to the site's other posts — grounded in the real posts given. Does not persist and never emits URLs: it returns a verbatim quote plus a candidate slug for the caller to apply.",
  annotations: {
    title: "Suggest Internal Links",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    body: z
      .string()
      .max(MAX_BODY_CHARS)
      .describe(
        "The post body as plain text — the prose to find link phrases in.",
      ),
    posts: z
      .array(
        z.object({
          title: z.string().max(MAX_TITLE_CHARS),
          slug: z.string().max(MAX_SLUG_CHARS),
        }),
      )
      .max(MAX_POSTS)
      .describe(
        "The site's other posts, each a title + slug — the only allowed link targets.",
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(8)
      .describe("Maximum number of links to propose."),
  }),

  outputSchema: z.object({
    suggestions: z
      .array(LinkSuggestionSchema)
      .describe("The proposed internal links, strongest first."),
  }),

  modelSummary: (r) =>
    `${r.suggestions.length} internal link(s) proposed. Not yet applied.`,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    if (input.posts.length === 0 || !input.body.trim()) {
      return { suggestions: [] };
    }

    const tier = await resolveTier(ctx, "smart");
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organizationId,
    );

    const prompt = [
      `## The site's other posts (link targets — title → slug)\n${input.posts
        .map((p) => `- ${p.title} → ${p.slug}`)
        .join("\n")}`,
      `## Post body\n${input.body}`,
      `## Your task\nPropose up to ${input.count} internal links.`,
    ].join("\n\n");

    const { object } = await generateObject({
      model: provider.aiSdk.languageModel(tier.modelId),
      schema: z.object({ suggestions: z.array(LinkSuggestionSchema) }),
      system: SYSTEM,
      temperature: 0.3,
      prompt,
    });

    const allowed = new Set(input.posts.map((p) => p.slug));
    const suggestions = object.suggestions
      .filter((s) => s.quote.trim() && allowed.has(s.slug))
      .slice(0, input.count);

    return { suggestions };
  },
});
