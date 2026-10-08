import { retryGenerateObject } from "./generate-object";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { resolveTier } from "../../core/resolve-tier";
import { BlogBrandSchema } from "./schema";
import { researchBrand } from "./brand-research";
import {
  applyVerdicts,
  type FieldSpec,
  flattenClaims,
  judgeClaims,
  logDiscarded,
} from "./confidence";
import {
  EvidenceBlocksSchema,
  EvidenceCatalogSchema,
  type EvidenceInput,
  EvidenceSeoSchema,
  renderEvidence,
} from "./evidence-prompt";

const SYSTEM = `You are identifying who a brand is, from its own website, so that blogposts generated later rest on facts about the company rather than on guesses. Every field of the output schema says what it wants and where to find it — work through them field by field.

You are answering WHO THIS COMPANY IS, not how it writes: the name, what it sells and to whom, the language it publishes in, who reads it, what it stands for, and who it competes with. A separate pass infers the writing rules, and it will be given your answer — so a vague description here weakens everything downstream.

Your input is Deco CMS blocks from a site's own repository, serialized as JSON and labelled with their block keys. Blog post and category blocks are the strongest evidence when they exist, because that is the brand writing posts. Many commerce sites have no blog at all, only page blocks (they carry a \`path\` and a \`sections\` array) — then page copy is all you get, and you work with it.

Prose is scattered across prop names, not held in one body field. Harvest it from every prop whose value reads like a sentence or a phrase a person wrote: \`text\`, \`title\`, \`description\`, \`label\`, \`caption\`, \`alt\`, and HTML fragments stored as strings (\`"<p>…</p>"\` — read through the tags). Short values count: \`alt: "92% de funcionárias"\` and \`alt: "do rio pro mundo"\` tell you more about a brand than a whole layout tree.

Two traps in real block data:

1. INTERNAL ANNOTATIONS ARE NOT COPY. Editors label assets for themselves: \`"[LP Rio - lojix] [carrossel detalhes]"\`, \`"Banner lojix"\`, \`"Desktop"\`, \`"20px"\`. Bracketed prefixes, campaign codenames, asset filenames and dimension labels are internal shorthand. Never read a brand's identity out of them.

2. OPERATIONAL AND LEGAL COPY IS FACT, NEVER IDENTITY. Shipping thresholds, return windows, payment restrictions and warranty terms are written by a different hand for a different purpose. \`commercialPolicies\` is where they belong, and there you copy the numbers exactly — a wrong threshold in a generated post is a promise the brand never made. Nowhere else: never read them as what the company stands for.

Two of your sections are not block prose, and are worth more per character.

THE SEO SECTION IS THE BRAND'S OWN ONE-LINE PITCH. A title and a description are rewritten until a team agrees they say what they want a stranger to think they are — that makes them the densest statement of positioning a site has. The entry keyed \`site\` is the default every page inherits, so it describes the company; the rest describe one page each. A title carrying \`%s\` is a template, so read the words around the slot, not the slot.

THE CATALOG SECTION IS WHAT THE COMPANY ACTUALLY SELLS. The category tree is the shape of the business; the product sample shows how it names things and what it charges. It is the best source for \`keywords\`, which are search terms rather than themes: the words the catalog uses for what it sells are the words customers type. Use it for \`description\` too.

Template placeholders like \`{size}\` or \`{name}\` are slots the site fills at render time. Read the sentence around them; never copy the placeholder into your answer.

Three rules that override everything else:
1. WRITE EVERY FIELD IN THE SITE'S OWN LANGUAGE — the same one you report in \`language\`. A site that writes in Portuguese gets a Portuguese profile: \`targetAudience\`, every rule \`name\` and every \`value\`. These instructions are in English because they are instructions; the brand's profile is content, and content follows the brand. Mixing the two languages makes the profile unusable — it is read by people who work in that language, and it is fed to a model that will copy the language it sees. The only exception is \`language\` itself, which stays a BCP-47 tag.
2. Every field must rest on prose you actually read here. Fidelity to what THIS company says about itself beats what a company in its category usually says.
3. No evidence means empty — an empty string or an empty array. A plausible-sounding guess is worse than a blank field, because someone will read it as fact and every post generated afterwards inherits it. A human reviews this afterwards and can fill a blank; they cannot un-read a confident invention.`;

/**
 * What the blocks alone can answer — a site does not publish the commercial
 * calendar it plans around, so `specialDates` comes from `researchBrand`.
 */
const BlockPassSchema = BlogBrandSchema.omit({ specialDates: true });

/**
 * What the gate judges, and what relevance is asking of each field.
 *
 * `companyName` and `language` are deliberately absent: they are identity, not
 * insight, so "how useful is this?" has no sensible answer for them — asked
 * anyway, the judge scored a correct brand name in the sixties and cut it. A
 * wrong name is obvious to the person reviewing; a missing one blocks every
 * generation downstream.
 *
 * `competitors` is marked block-derived because `preferFilled` prefers the
 * site's own answer; when research supplied it instead the judge still finds
 * it, since both sections are in the evidence it reads.
 */
const BRAND_FIELD_SPECS: readonly FieldSpec[] = [
  {
    field: "description",
    kind: "text",
    origin: "blocks",
    purpose:
      "Does it say what this company sells and who it sells to, concretely enough that you could tell it from a competitor in the same category?",
  },
  {
    field: "targetAudience",
    kind: "text",
    origin: "blocks",
    purpose:
      "Does it name who actually reads this brand and what they came for, rather than a demographic bracket that would fit any shopper?",
  },
  {
    field: "values",
    kind: "rules",
    origin: "blocks",
    purpose:
      "Is this something the brand argues for and backs up, rather than a virtue any company would claim? 'Quality' and 'innovation' with nothing attached are what this field is not for.",
  },
  {
    field: "competitors",
    kind: "rules",
    origin: "blocks",
    purpose:
      "Is this a real rival of this brand, with something said about how it positions itself or where it differs — enough for a writer to avoid sounding like it?",
  },
  {
    field: "keywords",
    kind: "terms",
    origin: "blocks",
    purpose:
      "Is this a term a customer would really type looking for what this brand sells? A product or category word belongs here even when it is ordinary — being unremarkable is what makes a search term work. The brand's own name alone does not.",
  },
  {
    field: "commercialPolicies",
    kind: "rules",
    origin: "blocks",
    purpose:
      "Does it state terms a post could repeat correctly — with the actual numbers, deadlines or conditions? A policy with none of those is 29 at most: 'the site references Frete Grátis in its metadata' is a fact about the metadata, not a policy. 'Frete grátis acima de R$ 199, exceto produtos pesados' is what this field is for.",
  },
  {
    field: "specialDates",
    kind: "rules",
    origin: "research",
    purpose:
      "Is this a commercial moment this brand's year actually turns around, with what the brand does on it? A general retail date with nothing tying it to this brand is 29 at most.",
  },
];
/** The site's own answer wins; research is what fills a blank. */
function preferFilled<T>(own: T[], researched: T[]): T[] {
  return own.length > 0 ? own : researched;
}

/** The evidence plus the research prose, so web-derived claims are checkable. */
function judgeEvidence(
  input: EvidenceInput,
  research: { text: string; sources: string[] },
): string {
  const evidence = renderEvidence(input);
  if (!research.text.trim()) return evidence;
  const citations = research.sources.length
    ? `\n\nSources cited:\n${research.sources.join("\n")}`
    : "";
  return `${evidence}\n\n---\n\n# Web research about this brand\n\n${research.text}${citations}`;
}

export const BLOG_BRAND_EXTRACT = defineTool({
  name: "BLOG_BRAND_EXTRACT",
  description:
    "Infer who a site's brand is (name, what it sells, language, audience, values, competitors) by reading its own CMS blocks. The writing rules are a separate pass — see BLOG_CONTEXT_EXTRACT, which takes this as input. Does not persist — the caller saves the result to the site's blog-manager-brand.json block.",
  annotations: {
    title: "Extract Editorial Brand",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    blocks: EvidenceBlocksSchema,
    seo: EvidenceSeoSchema,
    catalog: EvidenceCatalogSchema,
  }),

  outputSchema: BlogBrandSchema.extend({
    sources: z.array(z.string()).describe("Block keys the inference read"),
    researchSources: z
      .array(z.string())
      .describe(
        "URLs the web research cited. Empty when the org has no web_search tier, or the search found nothing — a claim with no source here was read off the site itself.",
      ),
    searched: z
      .boolean()
      .describe("True when web research ran and returned something."),
    discarded: z
      .number()
      .describe(
        "Claims the confidence judge rejected, and that this result therefore omits. Their text and scores go to the server log, never on the wire.",
      ),
    judged: z
      .boolean()
      .describe(
        "False when the judge was unavailable or answered incompletely — then nothing was filtered and every field is the raw extraction.",
      ),
  }),

  modelSummary: (r) =>
    `Brand inferred for ${r.companyName || "an unnamed brand"} from ${r.sources.length} block(s): ${r.language || "unknown"} language, ${r.values.length} values, ${r.competitors.length} competitors, ${r.specialDates.length} dates${r.searched ? ` (web research, ${r.researchSources.length} source(s))` : ""}. ${r.judged ? `${r.discarded} claim(s) fell below the confidence bar and were dropped` : "The confidence judge did not run, so nothing was filtered"}. Not yet saved; writing rules come from BLOG_CONTEXT_EXTRACT.`,

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

    const { object } = await retryGenerateObject({
      model: provider.aiSdk.languageModel(tier.modelId),
      schema: BlockPassSchema,
      system: SYSTEM,
      prompt: renderEvidence(input),
    });

    // After the research, never before: `researchBrand` gives up on a blank
    // `companyName`, so gating first could cost the whole web pass in silence.
    const research = await researchBrand(ctx, organizationId, object);

    const profile: Record<string, unknown> = {
      ...object,
      // Research only fills what the site's own copy could not answer.
      competitors: preferFilled(object.competitors, research.competitors),
      specialDates: research.specialDates,
    };

    const claims = flattenClaims(profile, BRAND_FIELD_SPECS);
    const gate = applyVerdicts(
      profile,
      claims,
      await judgeClaims(
        ctx,
        organizationId,
        {
          evidence: judgeEvidence(input, research),
          claims,
          specs: BRAND_FIELD_SPECS,
        },
        "BLOG_BRAND_EXTRACT",
      ),
      BRAND_FIELD_SPECS,
    );
    logDiscarded("BLOG_BRAND_EXTRACT", gate);

    return {
      ...(gate.kept as z.infer<typeof BlogBrandSchema>),
      researchSources: research.sources,
      searched: research.searched,
      discarded: gate.discarded.length,
      judged: gate.judged,
      sources: input.blocks.map((b) => b.key),
    };
  },
});
