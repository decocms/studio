import { generateObject, generateText } from "ai";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { resolveTier, tryResolveTier } from "../../core/resolve-tier";
import { BlogBrandSchema, type BrandRuleSchema } from "./schema";

/**
 * A theme is the unit of editorial planning: a title plus a brief. It is what a
 * human approves before anything is written, and later the input to the draft —
 * so the brief has to say enough that two different writers would produce the
 * same post from it.
 */
const ThemeSchema = z.object({
  title: z
    .string()
    .describe(
      "The theme as a person would say it out loud — the specific angle, not the subject area. 'Como ler a etiqueta de composição antes de comprar' is a theme; 'Moda sustentável' is a category. Not a headline: no clickbait, no colon-subtitle, no SEO stuffing.",
    ),
  body: z
    .string()
    .describe(
      "The brief, as markdown: the angle and why it is worth a post now, who it is for and what they came looking for, what the post must cover (a few concrete points), and what gives this brand the standing to say it. Two to four short paragraphs, or prose plus one short bullet list. No heading — the title is the heading.",
    ),
});

/** Caps on what a client may send — the request body is a trust boundary. */
const MAX_TITLES = 200;
const MAX_TITLE_CHARS = 300;
const MAX_CATEGORIES = 100;
const MAX_GUIDANCE_CHARS = 2_000;

const SYSTEM = `You are the editorial planner for a brand's blog. You propose themes: what this brand should publish next, and why. A human reads every one of them and keeps the good ones, so a proposal that is merely plausible wastes their time — aim for the ones they would not have thought of but recognize immediately as theirs.

WRITE EVERY TITLE AND EVERY BRIEF IN THE BRAND'S OWN LANGUAGE — the one reported as \`language\` in its profile. These instructions are in English because they are instructions; a theme is content, and content follows the brand. A brief in the wrong language is unusable: it is read by the people who work in that language, and it is fed to a model that will copy the language it sees.

What separates a theme from a topic:

1. A THEME HAS AN ANGLE, A CATEGORY DOES NOT. "Tendências de verão" is a slot in a taxonomy — every brand on earth could publish it, and the post that comes out says nothing. "Por que o linho amassa e o que isso diz sobre a peça" is a theme: it takes a position, and only a brand that knows fabric can write it.

2. STAND ON WHAT THIS BRAND ACTUALLY KNOWS. Read the brand's profile for what it sells, what it has claimed, and the values it argues for — that is its authority. A theme the brand cannot write credibly is worse than no theme, because someone will assign it and the result will be filler.

3. DO NOT PROPOSE WHAT ALREADY EXISTS. You are given the titles already published or already queued. Near-duplicates count: a different phrasing of a covered angle is a duplicate. Propose fewer themes rather than pad the list with variations.

4. RESPECT THE GUARDRAILS. The profile's \`avoid\` entries bind you as much as they bind the writer. So do its \`dos\` — if the brand names an ordinary thing its own way, use the brand's word in the title and the brief.

5. THE OPERATOR'S GUIDANCE OUTRANKS YOUR JUDGEMENT. When they say what they want themes about, every theme serves it. Only the language rule outranks them.

You may be given web research. Use it for what is being asked and discussed now, and for what competitors are publishing so you can propose the angle they left open. If the research is empty or off-target, ignore it and work from the brand — never invent a trend, a statistic or a competitor's move to justify a theme, because the brief becomes a false premise in the post written from it.

Variety is the point: themes that differ in angle, in reader intent and in how close they sit to the product beat five variations of the strongest one. If the brand's profile is nearly empty, say less in each brief rather than inventing a brand to fill them.`;

/**
 * What is being searched and published in the brand's space right now — the one
 * input neither the brand's own blocks nor the operator can supply.
 *
 * Same shape as `searchCompetitors` in `brand-extract.ts`: the search-capable
 * model is called directly with `generateText`, because the chat harness's
 * research hook in `quick` mode reduces to exactly that. Returns `""` when the
 * org has no `web_search` tier or on any failure — research enriches the
 * suggestion, it must never be what makes it fail.
 */
async function researchThemeContext(
  ctx: Parameters<typeof resolveTier>[0],
  organizationId: string,
  brand: Partial<z.infer<typeof BlogBrandSchema>>,
  guidance: string | undefined,
): Promise<string> {
  const company = brand.companyName?.trim();
  if (!company) return "";
  const tier = await tryResolveTier(ctx, "web_search");
  if (!tier) return "";

  const competitors = (brand.competitors ?? [])
    .map((c) => c.name)
    .filter(Boolean)
    .join(", ");

  try {
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organizationId,
    );
    const { text } = await generateText({
      model: provider.aiSdk.languageModel(tier.modelId),
      prompt: [
        `What is ${company}'s audience searching for and talking about right now?`,
        brand.description && `What the company does: ${brand.description}`,
        brand.targetAudience && `Its audience: ${brand.targetAudience}`,
        guidance && `Focus the research on: ${guidance}`,
        competitors &&
          `Also report what these competitors have published lately, and which angles they are NOT covering: ${competitors}`,
        `Search in the brand's own market and language (${brand.language || "unknown"}) — what a local reader searches for matters more than a global trend report. Report concrete questions, recurring complaints and seasonal moments, with sources. Say so plainly if you find little.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    return text.trim();
  } catch (err) {
    console.warn("[BLOG_THEME_SUGGEST] theme research failed", err);
    return "";
  }
}

function renderRules(
  label: string,
  rules: z.infer<typeof BrandRuleSchema>[] | undefined,
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
      renderRules("Values", brand.values),
      renderRules("Editorial instructions (dos)", brand.dos),
      renderRules("Guardrails (never do this)", brand.avoid),
      renderRules("Competitors", brand.competitors),
    ]
      .filter(Boolean)
      .join("\n\n") || "No brand profile has been filled in yet."
  );
}

export const BLOG_THEME_SUGGEST = defineTool({
  name: "BLOG_THEME_SUGGEST",
  description:
    "Propose blog themes for a brand — a title plus a brief for each — from its editorial brand context, the titles it already covers, an operator's guidance and web research. Does not persist: the caller saves each accepted theme as its own block.",
  annotations: {
    title: "Suggest Blog Themes",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    brand: BlogBrandSchema.partial().describe(
      "The site's editorial brand context, as stored in its blog-manager-brand block. Every field is optional — a half-filled profile is the normal case.",
    ),
    existingTitles: z
      .array(z.string().max(MAX_TITLE_CHARS))
      .max(MAX_TITLES)
      .default([])
      .describe(
        "Titles already published or already queued as themes. The exclusion list — nothing proposed may duplicate one of these, including near-duplicates.",
      ),
    categories: z
      .array(z.string().max(MAX_TITLE_CHARS))
      .max(MAX_CATEGORIES)
      .default([])
      .describe("The blog's existing categories, to place themes within them."),
    guidance: z
      .string()
      .max(MAX_GUIDANCE_CHARS)
      .optional()
      .describe(
        "What the operator wants themes about, in their own words — including any rough seed ideas to develop. Outranks every inference from the brand profile.",
      ),
    pillar: z
      .object({
        title: z.string().max(MAX_TITLE_CHARS),
        body: z.string().max(MAX_GUIDANCE_CHARS),
      })
      .optional()
      .describe(
        "The content pillar these themes must serve — the recurring territory they belong to. When set, every theme stays inside it.",
      ),
    formats: z
      .array(z.string().max(MAX_TITLE_CHARS))
      .max(MAX_CATEGORIES)
      .default([])
      .describe(
        "Names of the post formats the blog writes in, to bias themes toward angles those formats can carry.",
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe("How many themes to propose."),
  }),

  outputSchema: z.object({
    themes: z.array(ThemeSchema).describe("The proposed themes, best first"),
    searched: z
      .boolean()
      .describe(
        "True when web research fed the suggestion. False means the org has no web_search tier, or the search found nothing — the themes then rest on the brand profile alone.",
      ),
  }),

  modelSummary: (r) =>
    `${r.themes.length} theme(s) proposed${r.searched ? " with web research" : " from the brand profile alone"}: ${r.themes.map((t) => t.title).join("; ")}. Not yet saved.`,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const research = await researchThemeContext(
      ctx,
      organizationId,
      input.brand,
      input.guidance,
    );

    const tier = await resolveTier(ctx, "smart");
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organizationId,
    );

    const prompt = [
      renderBrand(input.brand),
      input.pillar &&
        `## Content pillar these themes must serve\n${input.pillar.title}${input.pillar.body ? `\n${input.pillar.body}` : ""}`,
      input.formats.length > 0 &&
        `## Formats the blog writes in\n${input.formats.join(", ")}`,
      input.categories.length > 0 &&
        `## Existing blog categories\n${input.categories.join(", ")}`,
      input.existingTitles.length > 0
        ? `## Already covered — do not propose these or near-duplicates\n${input.existingTitles.map((title) => `- ${title}`).join("\n")}`
        : "## Already covered\nNothing yet — this blog has no posts or themes.",
      input.guidance && `## What the operator asked for\n${input.guidance}`,
      research && `## Web research\n${research}`,
      `## Your task\nPropose ${input.count} themes.`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const { object } = await generateObject({
      model: provider.aiSdk.languageModel(tier.modelId),
      schema: z.object({ themes: z.array(ThemeSchema) }),
      system: SYSTEM,
      // Variety is the product here, unlike the extract's fidelity to evidence.
      temperature: 0.7,
      prompt,
    });

    return {
      themes: object.themes.slice(0, input.count),
      searched: research.length > 0,
    };
  },
});
