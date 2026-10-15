import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { requireBlogAi } from "./feature-flag";
import { GroundingInputSchema } from "./grounding-input";
import { BlogBrandSchema } from "./schema";
import { researchBrand } from "./brand-research";
import {
  applyVerdicts,
  flattenClaims,
  judgeClaims,
  logDiscarded,
} from "./confidence";
import {
  BlockPassSchema,
  brandFieldSpecs,
  judgeEvidence,
  preferFilled,
} from "./brand-extract";
import {
  EvidenceBlocksSchema,
  EvidenceSeoSchema,
  renderEvidence,
} from "./evidence-prompt";
import { renderGrounding } from "./site-tools";

/**
 * The two slow halves of a brand profile, after the profile exists.
 *
 * Reading a site's own blocks answers who a brand is. Two things it cannot
 * answer follow: what the web says about this company that its own copy never
 * would, and whether each claim is actually supported by the evidence it was
 * drawn from. Both are a model call of their own, and both used to run in the
 * same request as the extraction — three phases behind an edge proxy that gives
 * up at a hundred seconds, which is why extracting a brand answered 524.
 *
 * Enrichment in the strict sense: every field arrives already filled, and a
 * failure here returns the extraction untouched rather than nothing. A profile
 * that was not researched is a profile missing its competitors; a profile that
 * was not judged is the raw extraction, which is what the caller had anyway.
 */

export const BLOG_BRAND_ENRICH = defineTool({
  name: "BLOG_BRAND_ENRICH",
  description:
    "Finish a brand profile that BLOG_BRAND_EXTRACT started: research the company on the web for what its own site does not say, and drop the claims the evidence does not support. Takes the extraction and the same evidence it was read from. Does not persist — the caller saves the result.",
  annotations: {
    title: "Enrich Editorial Brand",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    /** The research pass searches the open web. */
    openWorldHint: true,
  },

  requiresAiBudget: true,

  inputSchema: z.object({
    profile: BlockPassSchema.describe(
      "The profile as BLOG_BRAND_EXTRACT returned it.",
    ),
    blocks: EvidenceBlocksSchema,
    seo: EvidenceSeoSchema,
    grounding: GroundingInputSchema,
  }),

  outputSchema: BlogBrandSchema.extend({
    researchSources: z
      .array(z.string())
      .describe(
        "URLs the web research cited. Empty when the org has no web_search tier, or the search found nothing.",
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
    `${r.companyName || "An unnamed brand"} enriched: ${r.competitors.length} competitor(s), ${r.specialDates.length} date(s)${r.searched ? `, ${r.researchSources.length} source(s)` : ", no web research"}. ${r.judged ? `${r.discarded} claim(s) fell below the confidence bar` : "The confidence judge did not run, so nothing was filtered"}.`,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }
    await requireBlogAi(ctx, organizationId);

    const { profile } = input;
    const research = await researchBrand(ctx, organizationId, profile);

    // Research only fills what the site's own copy could not answer.
    const competitors = preferFilled(profile.competitors, research.competitors);
    const filled: Record<string, unknown> = {
      ...profile,
      competitors: competitors.items,
      specialDates: research.specialDates,
    };

    const evidence = [
      renderEvidence(input),
      renderGrounding(input.grounding?.report ?? ""),
    ]
      .filter(Boolean)
      .join("\n\n---\n\n");

    const specs = brandFieldSpecs(competitors.origin);
    const claims = flattenClaims(filled, specs);
    const gate = applyVerdicts(
      filled,
      claims,
      await judgeClaims(
        ctx,
        organizationId,
        { evidence: judgeEvidence(evidence, research), claims, specs },
        "BLOG_BRAND_ENRICH",
      ),
      specs,
    );
    logDiscarded("BLOG_BRAND_ENRICH", gate);

    return {
      ...(gate.kept as z.infer<typeof BlogBrandSchema>),
      researchSources: research.sources,
      searched: research.searched,
      discarded: gate.discarded.length,
      judged: gate.judged,
    };
  },
});
