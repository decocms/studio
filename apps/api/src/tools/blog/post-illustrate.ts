import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { requireBlogAi } from "./feature-flag";
import { painterFor } from "./cover-image";
import { fetchProductPhotos, MAX_REFERENCE_PHOTOS } from "./product-photo";

/**
 * The pictures for a post, after the post exists.
 *
 * Drafting used to write the words and draw the cover in one request. The
 * drawing alone is allowed ninety seconds per image, so a run of three drafts
 * spent longer on pictures than the edge proxy allows for everything — and the
 * words, which are the product, were held hostage to them.
 *
 * Split, the text arrives first and is already editable on the board while this
 * runs. A failure here leaves a post without a cover, which is a post someone
 * finishes with two clicks in the editor.
 *
 * The product's own photographs are the point. Given only a written brief an
 * image model invents a plausible product, and a post about a backpack
 * illustrated with a backpack the brand does not sell is worse than a post with
 * no picture at all: it is a promise the catalogue cannot keep.
 */

const MAX_REQUESTS = 6;
const MAX_PROMPT_CHARS = 2_000;
const MAX_URL_CHARS = 2_048;

/** URLs offered as references. Only the first few that answer are used. */
const MAX_OFFERED_PHOTOS = 12;

export const BLOG_POST_ILLUSTRATE = defineTool({
  name: "BLOG_POST_ILLUSTRATE",
  description:
    "Draw the images a drafted post asked for and upload them to the organization's bucket. Give it the product photographs the post names and the generation is conditioned on the real product instead of inventing one. Returns an address per request, empty for any that could not be made — a post without its cover is still a post.",
  annotations: {
    title: "Illustrate a Post",
    /** Uploads what it draws to the organization's bucket. */
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    /** Fetches the product photographs from wherever the store serves them. */
    openWorldHint: true,
  },

  requiresAiBudget: true,

  inputSchema: z.object({
    requests: z
      .array(
        z.object({
          id: z
            .string()
            .max(128)
            .describe("The caller's own handle, echoed back on the result."),
          prompt: z
            .string()
            .max(MAX_PROMPT_CHARS)
            .describe(
              "What the image shows, as a photographic brief. The post's `cover.prompt` is exactly this.",
            ),
          alt: z
            .string()
            .max(MAX_PROMPT_CHARS)
            .default("")
            .describe("Alt text, used to name the file in the bucket."),
        }),
      )
      .min(1)
      .max(MAX_REQUESTS),
    productImages: z
      .array(z.string().max(MAX_URL_CHARS))
      .max(MAX_OFFERED_PHOTOS)
      .default([])
      .describe(
        `Image URLs of the products this post names, straight from the campaign. The first ${MAX_REFERENCE_PHOTOS} that answer condition the generation. Omit them and the model works from the brief alone, inventing the product.`,
      ),
    companyName: z
      .string()
      .max(200)
      .default("")
      .describe("Named in the brief, so the image reads as this brand's."),
    fileConfigId: z
      .string()
      .max(128)
      .optional()
      .describe(
        "Where an image is uploaded. Without it nothing is drawn — there would be nowhere to put the result.",
      ),
  }),

  outputSchema: z.object({
    images: z.array(
      z.object({
        id: z.string(),
        url: z
          .string()
          .describe("Empty when this one could not be made; never a sentinel."),
      }),
    ),
    outcome: z
      .enum(["ok", "no-bucket", "no-model", "failed"])
      .describe(
        "Why the addresses read as they do. `no-bucket` wants a bucket configured, `no-model` an image model on the org's tiers.",
      ),
    referenced: z
      .number()
      .int()
      .describe(
        "Product photographs that actually conditioned the generation. Zero means the images were drawn from the brief alone.",
      ),
  }),

  modelSummary: (r) =>
    `${r.images.filter((i) => i.url).length}/${r.images.length} image(s) drawn (${r.outcome})${r.referenced > 0 ? `, from ${r.referenced} product photo(s)` : ", from the brief alone"}.`,

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

    const painter = await painterFor(
      ctx,
      organizationId,
      input.fileConfigId,
      "BLOG_POST_ILLUSTRATE",
    );
    if (painter.outcome() !== "ok") {
      return {
        images: input.requests.map((request) => ({ id: request.id, url: "" })),
        outcome: painter.outcome(),
        referenced: 0,
      };
    }

    const references = await fetchProductPhotos(input.productImages);

    const images = await Promise.all(
      input.requests.map(async (request) => ({
        id: request.id,
        url: await painter.paint(
          brief(request.prompt, input.companyName),
          request.alt || request.prompt,
          references,
        ),
      })),
    );

    console.info(
      `[BLOG_POST_ILLUSTRATE] ${images.filter((i) => i.url).length}/${images.length} drawn from ${references.length} reference(s), images ${painter.outcome()}`,
    );

    return {
      images,
      outcome: painter.outcome(),
      referenced: references.length,
    };
  },
});

/** The caller's brief, attributed and stripped of lettering. */
function brief(prompt: string, companyName: string): string {
  const attribution = companyName ? ` published by ${companyName}` : "";
  return `Editorial photograph for a blog post${attribution}. ${prompt} No text, no lettering, no logo, no watermark anywhere in the image.`;
}
