import { generateObject } from "ai";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { tryResolveTier } from "../../core/resolve-tier";
import { BlogBrandSchema } from "./schema";

/**
 * A post format: a name plus a markdown brief that gets injected into the
 * generation prompt. Deliberately loose — it describes intent and emphasis, so
 * the model still decides the actual sequence of sections for a given theme.
 */
const FormatSchema = z.object({
  name: z
    .string()
    .describe(
      "The format named by the job it does — 'Guia prático', 'Lançamento de produto'. Not a description, not a section list.",
    ),
  value: z
    .string()
    .describe(
      "The brief, as markdown: when to reach for this format, roughly how it opens and closes, its length, and which sections carry it — each cited as `@ComponentName`. Two to four short paragraphs. No heading — the name is the heading.",
    ),
});

/** Caps on what a client may send — the request body is a trust boundary. */
const MAX_SECTIONS = 60;
const MAX_POSTS = 40;
const MAX_NAME_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 1_000;

const SYSTEM = `You name and describe the formats a blog writes in, so that generated posts are built the way this blog builds posts.

WRITE EVERY NAME AND EVERY BRIEF IN THE BRAND'S OWN LANGUAGE — the one reported as \`language\` in its profile. These instructions are in English because they are instructions; a format is content, and content follows the brand.

A BRIEF DESCRIBES INTENT, NEVER A FIXED SEQUENCE. This is the whole point of a format: it is injected into a generation prompt as guidance, and the model writing the post decides the actual order and count of sections for the theme in front of it. So write "normalmente abre com um @Heading e um parágrafo curto de contexto" — never "posição 1: @Heading, posição 2: @Paragraph". A numbered skeleton produces identical, lifeless posts; a described intent produces posts that fit their subject. If you catch yourself writing a list of positions, turn it back into prose.

CITE SECTIONS AS \`@ComponentName\`, using the exact name from the inventory you are given — \`@ProductShelf\`, not \`@Product Shelf\` or \`@shelf\`. These citations are how the format connects to what this site can actually render, and a name that isn't in the inventory points at nothing. Never cite a section that isn't listed.

READ THE EXISTING POSTS' STRUCTURES FOR THE FORMATS ALREADY IN USE. You are given, for each post, the sequence of sections it is built from. Recurring shapes are this blog's de-facto formats — group them, and name each group by the editorial job it does rather than by its parts. Two posts differing only in how many paragraphs they have are the same format. A shape that appears once is not a format; leave it out.

With no posts to read, propose formats from the brand profile and the section inventory: what would this brand plausibly publish, built from what this site can render.

Propose fewer, sharper formats over more. Three formats a writer can tell apart beat five that overlap — and two formats whose briefs would guide the same post are one format.`;

function renderRules(
  label: string,
  rules: { name: string; value: string }[] | undefined,
): string | null {
  if (!rules?.length) return null;
  const lines = rules
    .map((r) => `- ${r.name}${r.value ? `: ${r.value}` : ""}`)
    .join("\n");
  return `## ${label}\n${lines}`;
}

/** The brand profile as prose, skipping whatever the human hasn't filled in. */
function renderBrand(brand: Partial<z.infer<typeof BlogBrandSchema>>): string {
  return (
    [
      brand.companyName && `## Brand\n${brand.companyName}`,
      brand.description && `## What it does\n${brand.description}`,
      brand.language && `## Language to write in\n${brand.language}`,
      brand.tone && `## Tone of voice\n${brand.tone}`,
      brand.targetAudience && `## Audience\n${brand.targetAudience}`,
      renderRules("Editorial instructions (dos)", brand.dos),
      renderRules("Guardrails (never do this)", brand.avoid),
    ]
      .filter(Boolean)
      .join("\n\n") || "No brand profile has been filled in yet."
  );
}

export const BLOG_FORMAT_SUGGEST = defineTool({
  name: "BLOG_FORMAT_SUGGEST",
  description:
    "Name and describe the post formats a blog writes in, by reading the structure of its existing posts and the sections its site can render. Each format is a name plus a loose markdown brief citing sections as @ComponentName. Does not persist — the caller saves the result to the site's blog-manager-formats block.",
  annotations: {
    title: "Suggest Post Formats",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    brand: BlogBrandSchema.partial().describe(
      "The site's editorial brand context. Every field is optional — a half-filled profile is the normal case.",
    ),
    sections: z
      .array(
        z.object({
          name: z
            .string()
            .max(MAX_NAME_CHARS)
            .describe("Component name, the token a brief cites: ProductShelf"),
          title: z.string().max(MAX_NAME_CHARS),
          description: z.string().max(MAX_DESCRIPTION_CHARS).optional(),
        }),
      )
      .max(MAX_SECTIONS)
      .default([])
      .describe(
        "Every section this site can render inside a post. The only names a brief may cite.",
      ),
    postStructures: z
      .array(
        z.object({
          title: z.string().max(MAX_NAME_CHARS),
          sections: z
            .array(z.string().max(MAX_NAME_CHARS))
            .describe("Component names, in document order"),
        }),
      )
      .max(MAX_POSTS)
      .default([])
      .describe(
        "How each existing post is built. The shape of the posts, not their prose — this is what reveals the formats already in use.",
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(3)
      .describe("How many formats to propose."),
  }),

  outputSchema: z.object({
    formats: z.array(FormatSchema).describe("The proposed formats"),
    fallback: z
      .boolean()
      .describe(
        "True when the org has no `smart` tier, so nothing was generated and `formats` is empty. The caller writes its own starter format in that case.",
      ),
  }),

  modelSummary: (r) =>
    r.fallback
      ? "No model available for the `smart` tier, so no formats were generated."
      : `${r.formats.length} format(s) proposed: ${r.formats.map((f) => f.name).join("; ")}. Not yet saved.`,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    // Reported, not thrown: the caller's starter format needs no model.
    const tier = await tryResolveTier(ctx, "smart");
    if (!tier) return { formats: [], fallback: true };

    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organizationId,
    );

    const prompt = [
      renderBrand(input.brand),
      input.sections.length > 0
        ? `## Sections this site can render\n${input.sections
            .map(
              (s) =>
                `- @${s.name} (${s.title})${s.description ? ` — ${s.description}` : ""}`,
            )
            .join("\n")}`
        : "## Sections this site can render\nNone reported. Do not cite any section.",
      input.postStructures.length > 0
        ? `## How the existing posts are built\n${input.postStructures
            .map(
              (p) =>
                `- "${p.title || "(untitled)"}": ${p.sections.join(" → ") || "(no sections)"}`,
            )
            .join("\n")}`
        : "## How the existing posts are built\nThis blog has no posts yet.",
      `## Your task\nPropose at most ${input.count} formats.`,
    ].join("\n\n");

    const { object } = await generateObject({
      model: provider.aiSdk.languageModel(tier.modelId),
      schema: z.object({ formats: z.array(FormatSchema) }),
      system: SYSTEM,
      temperature: 0.6,
      prompt,
    });

    return {
      formats: object.formats.slice(0, input.count),
      fallback: false,
    };
  },
});
