import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { requireBlogAi } from "./feature-flag";
import { requireBlogConnections } from "./connections";
import { GroundingInputSchema, takeEvidence } from "./grounding-input";
import { extractCatalogue } from "./site-tools";

/**
 * The catalogue inside a grounding pass's raw output, read once.
 *
 * A pass gathers far more than its prose report keeps: the report judges and
 * compresses, which is right for findings and fatal for ids and image URLs. The
 * raw form is what holds those, and it is too large to travel — so the pass
 * leaves it in storage and this call is what turns it into a list.
 *
 * Its own request because of what it costs: several passes over several
 * hundred kilobytes. Bolted onto the generation that wants it, that generation
 * stops answering in time, which is the failure this whole split exists to end.
 *
 * Reading takes the evidence away. One grounding has one catalogue, nobody
 * reads it twice, and leaving an organization's catalogue sitting in object
 * storage after the one call that wanted it would be keeping it for no reason.
 */

const MAX_STORE_URL_CHARS = 2_048;

export const BLOG_SITE_CATALOGUE = defineTool({
  name: "BLOG_SITE_CATALOGUE",
  description:
    "Turn a grounding pass's raw output into the store's catalogue — products and categories with their ids, prices, addresses and image URLs as the store reported them. Takes the `evidence`/`evidenceUri` from BLOG_SITE_GROUND and consumes it: the stored copy is deleted on read.",
  annotations: {
    title: "Read the Site's Catalogue",
    /** Deletes the stored evidence it reads. */
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    /** Reads only what a previous pass already gathered. */
    openWorldHint: false,
  },

  requiresAiBudget: true,

  inputSchema: z.object({
    grounding: GroundingInputSchema,
    storeUrl: z
      .string()
      .max(MAX_STORE_URL_CHARS)
      .optional()
      .describe(
        "The brand's own storefront address. Every catalogue address is rebuilt onto it — a catalogue API answers on an internal host that resolves today and points nowhere a customer should be sent. Without it, addresses come back empty rather than wrong.",
      ),
  }),

  outputSchema: z.object({
    products: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        category: z.string(),
        price: z.string(),
        slug: z.string(),
        url: z.string(),
        images: z.array(z.string()),
        description: z.string(),
      }),
    ),
    targets: z.array(
      z.object({
        kind: z.enum(["category", "collection"]),
        id: z.string(),
        name: z.string(),
        slug: z.string(),
        url: z.string(),
      }),
    ),
    /** False when there was no raw output to read — not an error, just empty. */
    read: z.boolean(),
  }),

  modelSummary: (r) =>
    r.read
      ? `${r.products.length} product(s) and ${r.targets.length} target(s) from the store's own output.`
      : "No raw output to read; the catalogue is empty.",

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
    await requireBlogConnections(ctx, organizationId);

    const evidence = await takeEvidence(ctx, input.grounding);
    if (!evidence.trim()) {
      return { products: [], targets: [], read: false };
    }

    const catalogue = await extractCatalogue(
      ctx,
      organizationId,
      evidence,
      input.storeUrl,
      "BLOG_SITE_CATALOGUE",
    );
    return { ...catalogue, read: true };
  },
});
