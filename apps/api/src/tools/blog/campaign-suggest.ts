import { retryGenerateObject } from "./generate-object";
import { z } from "zod";
import {
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_TARGET_KINDS,
  CAMPAIGN_TRIGGERS,
  MAX_CAMPAIGN_PRODUCT_IMAGES,
} from "@decocms/shared/blog-campaign";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import {
  groundSiteReport,
  renderGrounding,
  VirtualMcpIdSchema,
} from "./site-tools";
import { resolveTier } from "../../core/resolve-tier";
import { BlogContextSchema, BrandRuleSchema } from "./schema";
import type { StudioContext } from "../../core/studio-context";

/**
 * A campaign is a temporary content pillar — a moment the brand writes into and
 * eventually comes back to. Filling one in by hand means knowing things that
 * live in the brand's systems rather than in anyone's head: what sells, what is
 * stuck, what people search for and do not find.
 *
 * So this tool starts from a seed — some keywords and a sentence — and reaches
 * the site's own connections to discover the rest. Without connections it still
 * answers, and says what it could not check.
 */

/** Caps on what a client may send — the request body is a trust boundary. */
const MAX_PROMPT_CHARS = 4_000;
const MAX_KEYWORDS = 50;
const MAX_EXISTING_NAMES = 100;
const MAX_TEXT_CHARS = 2_000;

/** Reading analytics *and* a catalogue is deeper than reading one site. */
const GROUNDING_MAX_STEPS = 14;
const GROUNDING_TIMEOUT_MS = 90_000;

const TargetSchema = z.object({
  kind: z.enum(CAMPAIGN_TARGET_KINDS),
  id: z
    .string()
    .max(MAX_TEXT_CHARS)
    .describe("The store's own id, exactly as a tool reported it. '' if none."),
  name: z.string().max(MAX_TEXT_CHARS),
  url: z
    .string()
    .max(MAX_TEXT_CHARS)
    .describe("The address a reader can open. Never invented."),
  description: z
    .string()
    .max(MAX_TEXT_CHARS)
    .describe("What falls inside this slice, and who it is for."),
});

const ProductSchema = z.object({
  id: z.string().max(MAX_TEXT_CHARS),
  name: z.string().max(MAX_TEXT_CHARS),
  url: z.string().max(MAX_TEXT_CHARS),
  images: z
    .array(z.string().max(MAX_TEXT_CHARS))
    .max(MAX_CAMPAIGN_PRODUCT_IMAGES),
  category: z.string().max(MAX_TEXT_CHARS),
  description: z.string().max(MAX_TEXT_CHARS),
});

/** A campaign as proposed — no key, no audit dates; the caller stamps those. */
const CampaignDraftSchema = z.object({
  name: z
    .string()
    .max(MAX_TEXT_CHARS)
    .describe("What someone would call this campaign. 'Black Friday 2026'."),
  period: z.object({
    start: z
      .string()
      .nullable()
      .describe("`YYYY-MM-DD`, or null when the moment has no fixed date."),
    end: z.string().nullable(),
  }),
  trigger: z.object({
    type: z.enum(CAMPAIGN_TRIGGERS),
    note: z
      .string()
      .max(MAX_TEXT_CHARS)
      .describe("Why this campaign exists now — what a writer reads first."),
  }),
  intent: z.object({
    objective: z.enum(CAMPAIGN_OBJECTIVES),
    targets: z.array(TargetSchema),
    products: z.array(ProductSchema),
    keywords: z.array(z.string().max(MAX_TEXT_CHARS)),
  }),
  guardrails: z.object({
    avoidComplements: z
      .array(BrandRuleSchema)
      .describe("Added to the brand's guardrails for this campaign only."),
    toneOverrides: z
      .string()
      .max(MAX_TEXT_CHARS)
      .describe("Replaces the brand's tone while this runs. '' to keep it."),
  }),
});

const ReviewSchema = z.object({
  index: z.number().int().describe("Which candidate, 1-based, in order given."),
  verdict: z.enum(["strong", "workable", "weak"]),
  rationale: z
    .string()
    .max(MAX_TEXT_CHARS)
    .describe(
      "Why, in the brand's language — the person reads this to choose.",
    ),
  risks: z
    .array(z.string().max(MAX_TEXT_CHARS))
    .describe("What could go wrong, or what is unverified. Empty if none."),
});

const SYSTEM = `You propose blog campaigns for a brand. A campaign is a temporary content pillar: a moment the brand writes into — a launch, a date, a search it does not answer, stock that needs to move — with a period, a target and an objective.

WRITE EVERY NAME, NOTE AND DESCRIPTION IN THE BRAND'S OWN LANGUAGE, the one reported as \`language\`. These instructions are in English because they are instructions; a campaign is content.

DO NOT FORCE VARIETY. You are told a maximum, not a quota. If the seed already pins the campaign down — a named date, one product line, a single angle — return ONE. Return several only when the seed genuinely admits different readings, and say in each rationale what makes that reading different from the others. Three near-duplicates are worse than one good campaign, because the person has to read all three to find that out.

NEVER INVENT THE STORE. Targets and products may only come from what the tools actually reported. If no store data came back, return empty \`targets\` and \`products\` and record what you could not check. A made-up product URL is worse than a blank field: a blank field asks to be filled, a wrong URL gets published.

The same goes for figures. A price, a stock level or a traffic number belongs here only if a tool returned it, copied exactly.

DATES. You are given today's date. A seasonal campaign should carry the period it actually runs. When the moment has no fixed date, use null rather than guessing — a wrong date is read as a commitment.

Set \`keywords\` to what this campaign wants to be found by, starting from the seed's terms but not limited to them.

Fill \`guardrails\` only where this campaign needs something the brand's standing context does not already say. An empty guardrail is the normal case.

Do not repeat a campaign the brand already has — you are given their names.`;

const REVIEW_SYSTEM = `You review proposed blog campaigns for the person who has to choose between them. You did not write them.

Judge each on three things: whether it answers the seed, whether it is specific enough to write from, and whether its targets, products and figures are grounded in what the tools actually reported rather than assumed.

- \`strong\`: a writer could start today, and the store data backs it.
- \`workable\`: the idea holds, but something needs filling in or checking first.
- \`weak\`: too vague to write from, duplicates another candidate, or rests on facts nothing confirmed.

A campaign with empty targets and products is NOT weak for that reason alone when no store data was available — say that is what needs filling, and judge the thinking.

List under \`risks\` anything unverified, anything that could age badly, and any claim you could not trace to the grounding. Be concrete: "the price cited appears nowhere in the tool results" beats "check the facts".

Write the rationale in the brand's own language — the person reads it to decide.`;

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

function renderBrand(
  brand: Partial<z.infer<typeof BlogContextSchema>>,
): string {
  return (
    [
      brand.companyName && `## Brand\n${brand.companyName}`,
      brand.description && `## What it does\n${brand.description}`,
      brand.language && `## Language to write in\n${brand.language}`,
      brand.tone && `## Tone of voice\n${brand.tone}`,
      brand.targetAudience && `## Audience\n${brand.targetAudience}`,
      renderRules("Editorial instructions (dos)", brand.dos),
      renderRules("Guardrails (never do this)", brand.avoid),
      renderRules("Special dates", brand.specialDates),
    ]
      .filter(Boolean)
      .join("\n\n") || "No brand profile has been filled in yet."
  );
}

/**
 * Drop anything the store never reported.
 *
 * The prompt forbids inventing a target or a product, but a prompt is a request
 * and this is the guarantee. With no grounding there is nothing to check
 * against, so everything goes — that is the honest reading of "nothing was
 * verifiable", and the UI says so rather than showing invented links.
 */
export function groundedOnly<T extends { name: string; url: string }>(
  items: T[],
  grounding: string,
): T[] {
  if (!grounding.trim()) return [];
  const haystack = grounding.toLowerCase();
  return items.filter((item) => {
    const name = item.name.trim().toLowerCase();
    const url = item.url.trim().toLowerCase();
    return (
      (!!name && haystack.includes(name)) || (!!url && haystack.includes(url))
    );
  });
}

/** What the person is told was missing, given what actually happened. */
export function describeGaps(
  report: { toolNames: string[]; ran: boolean },
  grounding: string,
  dropped: { targets: number; products: number },
): string[] {
  const gaps: string[] = [];
  if (!report.ran) {
    gaps.push(
      "No connected system answered, so nothing here was checked against the store: targets, products and any figure are the brand context only.",
    );
  } else if (!grounding.trim()) {
    gaps.push(
      "The connected systems were reachable but reported nothing useful for this seed.",
    );
  }
  if (dropped.targets > 0) {
    gaps.push(
      `${dropped.targets} proposed target(s) were dropped: nothing in the store data backed them.`,
    );
  }
  if (dropped.products > 0) {
    gaps.push(
      `${dropped.products} proposed product(s) were dropped: nothing in the store data backed them.`,
    );
  }
  return gaps;
}

/** The review that stands in when the reviewer itself fails. */
export function unreviewed(count: number): z.infer<typeof ReviewSchema>[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    verdict: "workable" as const,
    rationale: "",
    risks: [],
  }));
}

/**
 * Pair reviews back to candidates by index.
 *
 * Out-of-range and duplicate indices are ignored rather than trusted: a review
 * attached to the wrong campaign is worse than no review, because the person
 * acts on it.
 */
export function pairReviews<T>(
  candidates: T[],
  reviews: z.infer<typeof ReviewSchema>[],
): (T & { review: Omit<z.infer<typeof ReviewSchema>, "index"> })[] {
  const byIndex = new Map<number, z.infer<typeof ReviewSchema>>();
  for (const review of reviews) {
    if (!Number.isInteger(review.index)) continue;
    if (review.index < 1 || review.index > candidates.length) continue;
    if (!byIndex.has(review.index)) byIndex.set(review.index, review);
  }
  return candidates.map((candidate, i) => {
    const found = byIndex.get(i + 1);
    return {
      ...candidate,
      review: {
        verdict: found?.verdict ?? ("workable" as const),
        rationale: found?.rationale ?? "",
        risks: found?.risks ?? [],
      },
    };
  });
}

async function reviewCampaigns(
  ctx: StudioContext,
  organizationId: string,
  candidates: z.infer<typeof CampaignDraftSchema>[],
  grounding: string,
  language: string | undefined,
): Promise<z.infer<typeof ReviewSchema>[]> {
  try {
    const tier = await resolveTier(ctx, "smart");
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organizationId,
    );
    const { object } = await retryGenerateObject({
      model: provider.aiSdk.languageModel(tier.modelId),
      schema: z.object({ reviews: z.array(ReviewSchema) }),
      system: REVIEW_SYSTEM,
      prompt: [
        language && `## Language to write the rationale in\n${language}`,
        renderGrounding(grounding) ??
          "## What the store reported\nNothing — no connected system answered.",
        `## The candidates\n${JSON.stringify(candidates, null, 2)}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    return object.reviews;
  } catch (err) {
    console.warn("[BLOG_CAMPAIGN_SUGGEST] review pass failed", err);
    return unreviewed(candidates.length);
  }
}

export const BLOG_CAMPAIGN_SUGGEST = defineTool({
  name: "BLOG_CAMPAIGN_SUGGEST",
  description:
    "Propose blog campaigns from a seed — keywords plus a sentence about the moment — by reading the site's own connected systems (analytics, catalogue) for what is actually selling, searched for or stuck. Returns up to `count` candidates, each with a separate review, plus what could not be checked. Does not persist: the caller saves the chosen ones as campaign blocks.",
  annotations: {
    title: "Suggest Campaigns",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    seed: z.object({
      keywords: z
        .array(z.string().max(MAX_TEXT_CHARS))
        .max(MAX_KEYWORDS)
        .default([])
        .describe("The terms this campaign should aim at."),
      prompt: z
        .string()
        .max(MAX_PROMPT_CHARS)
        .describe("What the moment is, in the operator's own words."),
    }),
    brand: BlogContextSchema.partial().describe(
      "The site's editorial brand context. Every field is optional.",
    ),
    existingNames: z
      .array(z.string().max(MAX_TEXT_CHARS))
      .max(MAX_EXISTING_NAMES)
      .default([])
      .describe("Campaigns the brand already has, so none is proposed twice."),
    count: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(3)
      .describe("The most candidates to return. Fewer is a valid answer."),
    virtualMcpId: VirtualMcpIdSchema,
  }),
  outputSchema: z.object({
    campaigns: z.array(
      CampaignDraftSchema.extend({
        review: ReviewSchema.omit({ index: true }),
      }),
    ),
    /** True when a connected system actually answered. */
    grounded: z.boolean(),
    /** The read-only tools the site exposed, for the operator to recognise. */
    toolsUsed: z.array(z.string()),
    /** Plain sentences about what could not be checked. */
    gaps: z.array(z.string()),
  }),

  // Two model passes plus a tool-calling sweep — a spent envelope has to stop it.
  requiresAiBudget: true,

  modelSummary: (r) =>
    `${r.campaigns.length} campaign(s) proposed: ${r.campaigns
      .map((c) => `${c.name} (${c.review.verdict})`)
      .join(
        "; ",
      )}. ${r.grounded ? "Grounded in the site's systems." : "No store data available."} Not yet saved.`,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const brandName = input.brand.companyName ?? "this brand";
    const report = await groundSiteReport(ctx, organizationId, {
      virtualMcpId: input.virtualMcpId,
      language: input.brand.language,
      label: "BLOG_CAMPAIGN_SUGGEST",
      maxSteps: GROUNDING_MAX_STEPS,
      timeoutMs: GROUNDING_TIMEOUT_MS,
      task: `Proposing blog campaigns for ${brandName}, starting from: ${input.seed.prompt}`,
      wanted: [
        "What is selling and what has stalled, with the product names, ids, URLs, images and categories exactly as reported.",
        "Which categories or collections these products sit in, with their URLs.",
        "What readers arrive searching for, which pages they land on, and which queries bring traffic the brand does not rank for.",
        "Any promotion, season or launch already in flight.",
        `Anything bearing on these terms: ${input.seed.keywords.join(", ") || "(none given)"}.`,
      ].join("\n"),
    });

    const grounding = report.grounding;
    const today = new Date().toISOString().slice(0, 10);

    const tier = await resolveTier(ctx, "smart");
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organizationId,
    );

    const { object } = await retryGenerateObject({
      model: provider.aiSdk.languageModel(tier.modelId),
      schema: z.object({ campaigns: z.array(CampaignDraftSchema) }),
      system: SYSTEM,
      prompt: [
        `## Today\n${today}`,
        renderBrand(input.brand),
        `## The seed\n${input.seed.prompt}`,
        input.seed.keywords.length > 0 &&
          `## Terms to aim at\n${input.seed.keywords.map((k) => `- ${k}`).join("\n")}`,
        renderGrounding(grounding) ??
          "## What the store reported\nNo connected system answered. Leave `targets` and `products` empty — do not fill them from what you know about the category.",
        input.existingNames.length > 0 &&
          `## Campaigns this brand already has\n${input.existingNames.map((n) => `- ${n}`).join("\n")}`,
        `## Your task\nPropose at most ${input.count} campaign(s). One is a good answer when the seed only supports one.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });

    let droppedTargets = 0;
    let droppedProducts = 0;
    const candidates = object.campaigns
      .slice(0, input.count)
      .map((campaign) => {
        const targets = groundedOnly(campaign.intent.targets, grounding);
        const products = groundedOnly(campaign.intent.products, grounding);
        droppedTargets += campaign.intent.targets.length - targets.length;
        droppedProducts += campaign.intent.products.length - products.length;
        return {
          ...campaign,
          intent: { ...campaign.intent, targets, products },
        };
      });

    const reviews =
      candidates.length > 0
        ? await reviewCampaigns(
            ctx,
            organizationId,
            candidates,
            grounding,
            input.brand.language,
          )
        : [];

    return {
      campaigns: pairReviews(candidates, reviews),
      grounded: report.ran && grounding.trim().length > 0,
      toolsUsed: report.toolNames,
      gaps: describeGaps(report, grounding, {
        targets: droppedTargets,
        products: droppedProducts,
      }),
    };
  },
});
