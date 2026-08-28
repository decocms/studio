import { generateObject } from "ai";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { resolveTier } from "../../core/resolve-tier";
import { BlogBrandSchema } from "./schema";

/** Section kinds a draft may be built from. */
const SECTION_TYPES = [
  "Heading",
  "Paragraph",
  "List",
  "Quote",
  "Callout",
  "Cta",
  "Divider",
] as const;

/**
 * One section of the post body.
 *
 * Flat, with every prop optional and one `type` enum, rather than a
 * discriminated union: the caller has to validate and drop sections anyway
 * (a site may not expose every kind), so the union would buy no real safety
 * while pushing an `anyOf` schema through structured output, which is the kind
 * of thing that works on three providers and fails on the fourth.
 */
const SectionSchema = z.object({
  type: z.enum(SECTION_TYPES).describe("Which kind of section this is"),
  text: z
    .string()
    .optional()
    .describe("Heading: the heading itself. Cta: the button label."),
  level: z
    .enum(["1", "2", "3"])
    .optional()
    .describe(
      "Heading only. The post title is the h1, so body headings start at 2.",
    ),
  html: z
    .string()
    .optional()
    .describe(
      "Paragraph only: the prose as simple inline HTML — `<strong>`, `<em>`, `<a href>` and nothing else. No wrapping `<p>`, no block tags, no classes or styles.",
    ),
  items: z
    .array(z.string())
    .optional()
    .describe("List only: one entry per bullet, plain text."),
  style: z
    .enum(["ordered", "unordered"])
    .optional()
    .describe("List only. `ordered` when the order is the point."),
  quote: z.string().optional().describe("Quote only: the quoted line."),
  title: z.string().optional().describe("Callout only: its short heading."),
  body: z.string().optional().describe("Callout only: one or two sentences."),
  variant: z
    .enum(["info", "tip", "warning", "product"])
    .optional()
    .describe("Callout only."),
  href: z
    .string()
    .optional()
    .describe(
      "Cta only: a path on this site, e.g. `/colecao/verao`. Never invent an external URL.",
    ),
});

const MAX_NAME_CHARS = 200;
const MAX_BODY_CHARS = 8_000;
const MAX_SECTIONS = 40;
const MAX_CATEGORIES = 100;
const MAX_AUTHORS = 100;

const SYSTEM = `You write one blog post for a brand, from a theme (what it is about) and a format (how this brand builds a post of that kind).

WRITE THE WHOLE POST IN THE BRAND'S OWN LANGUAGE — the one reported as \`language\` in its profile. These instructions are in English because they are instructions; the post is content, and content follows the brand.

THE BRAND PROFILE IS BINDING, NOT BACKGROUND. Its \`tone\` says how to sound, and you reproduce it rather than approximating it — pronoun, sentence length, formality, casing. Its \`dos\` are instructions you follow. Its \`avoid\` entries are prohibitions: a post that breaks one is a failure however well written. Where the brand renames an ordinary thing, use the brand's word.

THE PILLAR IS THE GROUND, THE THEME IS THE ANGLE. A pillar is a territory this brand returns to across many posts; the theme is the one angle this post takes within it. Write the angle, not the territory — a post that restates the pillar is the article the brand already published.

THE THEME IS THE BRIEF, THE FORMAT IS THE SHAPE. The theme's body says the angle, who it is for and what to cover — cover it. The format describes how a post like this usually opens, develops and closes, and cites sections as \`@Name\`; treat those citations as what this brand reaches for, not as a fixed running order. You choose the actual sequence and how many of each, because that depends on this theme.

USE ONLY THE SECTION KINDS YOU ARE GIVEN. Each has a listed purpose. A kind that isn't listed does not exist on this site, and emitting one loses that part of the post silently.

WRITE SOMETHING WORTH READING. Open on the reader's problem or curiosity, never on the company. Make every section carry a specific claim, an example or a number rather than restating the heading. Vary section length. Close with one clear next step.

NEVER INVENT A VERIFIABLE FACT. No statistics, prices, dates, product names, awards or quotes from real people unless they came from the brand profile or the theme. Say less rather than fabricate: a human reviews this and can add a number, but cannot tell which of your numbers you made up.

The excerpt is what a reader sees in a list — a sentence that earns the click, not the first line of the post repeated. The SEO title and description are for search results: the title carries the searched phrase and stays under about 60 characters, the description states the payoff in under about 155.

FILE AND ATTRIBUTE THE POST. Pick the categories it belongs in and the author it most sounds like, from the lists you are given — usually one of each. Choose only from those lists: anything else is dropped, and the post lands unfiled or unattributed. Given an empty list, return an empty list.`;

function renderRules(
  label: string,
  rules: { name: string; value: string }[] | undefined,
): string | null {
  if (!rules?.length) return null;
  return `## ${label}\n${rules
    .map((r) => `- ${r.name}${r.value ? `: ${r.value}` : ""}`)
    .join("\n")}`;
}

export const BLOG_POST_DRAFT = defineTool({
  name: "BLOG_POST_DRAFT",
  description:
    "Write one blog post from a brand's editorial context, a theme and a format. Returns the post's copy and its body as a list of sections; does not persist — the caller builds the block and schedules it.",
  annotations: {
    title: "Draft a Blog Post",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    brand: BlogBrandSchema.partial().describe(
      "The site's editorial brand context. companyName, language, description, tone, targetAudience, dos and avoid are all required here — a post written without them is generic.",
    ),
    pillar: z
      .object({
        title: z.string().max(MAX_NAME_CHARS),
        body: z.string().max(MAX_BODY_CHARS),
      })
      .optional()
      .describe(
        "The recurring territory this post belongs to — the ground the brand keeps returning to, which the theme is one angle within.",
      ),
    theme: z
      .object({
        title: z.string().max(MAX_NAME_CHARS),
        body: z.string().max(MAX_BODY_CHARS),
      })
      .describe("What the post is about: its title and its brief."),
    format: z
      .object({
        name: z.string().max(MAX_NAME_CHARS),
        value: z.string().max(MAX_BODY_CHARS),
      })
      .describe("How this brand builds a post of this kind."),
    sections: z
      .array(
        z.object({
          type: z.enum(SECTION_TYPES),
          purpose: z.string().max(MAX_NAME_CHARS).optional(),
        }),
      )
      .min(1)
      .describe(
        "The only section kinds this site can render. Anything absent from this list must not be used.",
      ),
    categories: z
      .array(
        z.object({
          name: z.string().max(MAX_NAME_CHARS),
          slug: z.string().max(MAX_NAME_CHARS),
        }),
      )
      .max(MAX_CATEGORIES)
      .default([])
      .describe("The blog's categories, to file this post under."),
    authors: z
      .array(
        z.object({
          name: z.string().max(MAX_NAME_CHARS),
          email: z.string().max(MAX_NAME_CHARS),
          bio: z.string().max(MAX_BODY_CHARS).optional(),
        }),
      )
      .max(MAX_AUTHORS)
      .default([])
      .describe(
        "The blog's authors, to attribute this post to. Pick whoever this post most sounds like it came from.",
      ),
    extraInstructions: z
      .string()
      .max(MAX_BODY_CHARS)
      .optional()
      .describe(
        "What the operator asked for on top of everything else, in their own words.",
      ),
  }),

  outputSchema: z.object({
    title: z
      .string()
      .describe("The post's headline, in the brand's voice and language"),
    excerpt: z.string().describe("One sentence that earns the click"),
    seo: z.object({
      title: z.string().describe("Search-result title, ~60 characters"),
      description: z.string().describe("Search-result description, ~155"),
    }),
    categorySlugs: z
      .array(z.string())
      .describe("Slugs chosen from the given categories — usually one"),
    authorEmails: z
      .array(z.string())
      .describe("Emails chosen from the given authors — usually one"),
    sections: z
      .array(SectionSchema)
      .max(MAX_SECTIONS)
      .describe("The post body, in reading order"),
  }),

  modelSummary: (r) =>
    `Drafted "${r.title}" — ${r.sections.length} section(s), ${r.categorySlugs.length} category(ies), ${r.authorEmails.length} author(s). Not yet saved.`,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const { brand } = input;
    const missing = [
      !brand.companyName?.trim() && "companyName",
      !brand.language?.trim() && "language",
      !brand.description?.trim() && "description",
      !brand.tone?.trim() && "tone",
      !brand.targetAudience?.trim() && "targetAudience",
      !brand.dos?.length && "dos",
      !brand.avoid?.length && "avoid",
    ].filter((field): field is string => typeof field === "string");
    if (missing.length > 0) {
      throw new Error(
        `Editorial brand context is incomplete — fill ${missing.join(", ")} before generating. A post written without it reads like any other brand's.`,
      );
    }

    const tier = await resolveTier(ctx, "thinking");
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organizationId,
    );

    const prompt = [
      `## Brand\n${brand.companyName}`,
      `## What it does\n${brand.description}`,
      `## Language to write in\n${brand.language}`,
      `## Tone of voice\n${brand.tone}`,
      `## Audience\n${brand.targetAudience}`,
      renderRules("Values", brand.values),
      renderRules("Editorial instructions — follow these", brand.dos),
      renderRules("Guardrails — never do these", brand.avoid),
      input.pillar
        ? `## Pillar: ${input.pillar.title}\n${input.pillar.body}`
        : null,
      `## Theme: ${input.theme.title}\n${input.theme.body}`,
      `## Format: ${input.format.name}\n${input.format.value}`,
      `## Section kinds available\n${input.sections
        .map((s) => `- ${s.type}${s.purpose ? ` — ${s.purpose}` : ""}`)
        .join("\n")}`,
      input.categories.length > 0
        ? `## Categories\n${input.categories.map((c) => `- ${c.name} (${c.slug})`).join("\n")}`
        : null,
      input.authors.length > 0
        ? `## Authors\n${input.authors
            .map((a) => `- ${a.name} (${a.email})${a.bio ? ` — ${a.bio}` : ""}`)
            .join("\n")}`
        : null,
      input.extraInstructions
        ? `## What the operator asked for\n${input.extraInstructions}`
        : null,
      "## Your task\nWrite the post.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const { object } = await generateObject({
      model: provider.aiSdk.languageModel(tier.modelId),
      schema: z.object({
        title: z.string(),
        excerpt: z.string(),
        seo: z.object({ title: z.string(), description: z.string() }),
        categorySlugs: z.array(z.string()),
        authorEmails: z.array(z.string()),
        sections: z.array(SectionSchema),
      }),
      system: SYSTEM,
      temperature: 0.7,
      prompt,
    });

    const allowed = new Set(input.sections.map((s) => s.type));
    const allowedSlugs = new Set(input.categories.map((c) => c.slug));
    const allowedEmails = new Set(input.authors.map((a) => a.email));
    return {
      ...object,
      // The prompt says so, but the list is what the caller renders.
      sections: object.sections
        .filter((section) => allowed.has(section.type))
        .slice(0, MAX_SECTIONS),
      categorySlugs: object.categorySlugs.filter((slug) =>
        allowedSlugs.has(slug),
      ),
      authorEmails: object.authorEmails.filter((email) =>
        allowedEmails.has(email),
      ),
    };
  },
});
