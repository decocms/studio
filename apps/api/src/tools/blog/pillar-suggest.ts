import { generateObject } from "ai";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { resolveTier } from "../../core/resolve-tier";
import { BlogBrandSchema, type BrandRuleSchema } from "./schema";

/**
 * A content pillar is a recurring territory of communication — "Product
 * updates", "Customer cases", "Market & trends". It is broader than a single
 * post's angle (that is an idea) and broader than a taxonomy slot (that is a
 * category): it is a lane the brand keeps returning to, and many posts in many
 * formats live under it.
 */
const PillarSchema = z.object({
  title: z
    .string()
    .describe(
      "The territory named the way this brand would say it — 'Bastidores da produção', 'Educação do consumidor'. A short noun phrase, not a headline and not a single post's angle.",
    ),
  body: z
    .string()
    .describe(
      "The brief, as markdown: what this territory covers, why it is one this brand keeps returning to, and the kind of reader it serves. One or two short paragraphs. No heading — the title is the heading.",
    ),
});

/** Caps on what a client may send — the request body is a trust boundary. */
const MAX_TITLES = 200;
const MAX_TITLE_CHARS = 300;
const MAX_CATEGORIES = 100;
const MAX_GUIDANCE_CHARS = 2_000;

const SYSTEM = `You are the editorial strategist for a brand's blog. You propose content pillars: the handful of recurring territories this brand should keep publishing in. A pillar is a lane, not a single post — many posts in many formats will live under each one.

WRITE EVERY TITLE AND EVERY BRIEF IN THE BRAND'S OWN LANGUAGE — the one reported as \`language\` in its profile. These instructions are in English because they are instructions; a pillar is content, and content follows the brand.

What makes a good pillar:

1. A PILLAR IS RECURRING, NOT A ONE-OFF. "Como escolher o tamanho certo" is a single post; "Guia de produtos" is a pillar it could live under. Propose the lane, not the article.

2. IT IS NOT A CATEGORY. A category is a taxonomy slot the reader browses; a pillar is a strategic bet about what this brand has authority to keep saying. They may overlap, but name the pillar by the editorial job it does, not by the product taxonomy.

3. STAND ON WHAT THIS BRAND ACTUALLY KNOWS. Read the profile for what it sells, what it has claimed, and the values it argues for — a pillar the brand cannot sustain is worse than none.

4. FEW AND DISTINCT. Three to six pillars a team can tell apart beat a long list that overlaps. Two pillars that would hold the same posts are one pillar.

If the brand's profile is nearly empty, propose fewer, and say less in each brief rather than inventing a brand to fill them.`;

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
    ]
      .filter(Boolean)
      .join("\n\n") || "No brand profile has been filled in yet."
  );
}

export const BLOG_PILLAR_SUGGEST = defineTool({
  name: "BLOG_PILLAR_SUGGEST",
  description:
    "Propose content pillars for a brand — recurring communication territories, a title plus a brief each — from its editorial brand context and the pillars it already has. Does not persist: the caller saves each accepted pillar as its own block.",
  annotations: {
    title: "Suggest Content Pillars",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    brand: BlogBrandSchema.partial().describe(
      "The site's editorial brand context, as stored in its blog-manager-brand block. Every field is optional — a half-filled profile is the normal case.",
    ),
    existingPillars: z
      .array(z.string().max(MAX_TITLE_CHARS))
      .max(MAX_TITLES)
      .default([])
      .describe(
        "Titles of pillars the blog already has. The exclusion list — nothing proposed may duplicate one of these, including near-duplicates.",
      ),
    categories: z
      .array(z.string().max(MAX_TITLE_CHARS))
      .max(MAX_CATEGORIES)
      .default([])
      .describe(
        "The blog's existing categories, for context — a pillar may span several, and need not mirror the taxonomy.",
      ),
    guidance: z
      .string()
      .max(MAX_GUIDANCE_CHARS)
      .optional()
      .describe(
        "What the operator wants pillars about, in their own words. Outranks every inference from the brand profile.",
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(8)
      .default(5)
      .describe("How many pillars to propose."),
  }),

  outputSchema: z.object({
    pillars: z
      .array(PillarSchema)
      .describe("The proposed content pillars, best first"),
  }),

  modelSummary: (r) =>
    `${r.pillars.length} pillar(s) proposed: ${r.pillars.map((p) => p.title).join("; ")}. Not yet saved.`,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const tier = await resolveTier(ctx, "smart");
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organizationId,
    );

    const prompt = [
      renderBrand(input.brand),
      input.categories.length > 0 &&
        `## Existing blog categories\n${input.categories.join(", ")}`,
      input.existingPillars.length > 0
        ? `## Pillars already defined — do not propose these or near-duplicates\n${input.existingPillars.map((title) => `- ${title}`).join("\n")}`
        : "## Pillars already defined\nNone yet — this blog has no pillars.",
      input.guidance && `## What the operator asked for\n${input.guidance}`,
      `## Your task\nPropose ${input.count} content pillars.`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const { object } = await generateObject({
      model: provider.aiSdk.languageModel(tier.modelId),
      schema: z.object({ pillars: z.array(PillarSchema) }),
      system: SYSTEM,
      temperature: 0.6,
      prompt,
    });

    return { pillars: object.pillars.slice(0, input.count) };
  },
});
