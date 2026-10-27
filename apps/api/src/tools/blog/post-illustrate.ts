import { z } from "zod";
import { MAX_OFFERED_PHOTOS } from "@decocms/shared/blog-campaign";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { requireBlogAi } from "./feature-flag";
import { painterFor } from "./cover-image";
import {
  clearSentinels,
  IMAGE_SENTINEL,
  sentinelRequests,
  withImageAt,
} from "./block-props";
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

/** Body images per post. The same ceiling drafting used when it drew them. */
const MAX_BODY_IMAGES = 2;
const MAX_PROMPT_CHARS = 2_000;
const MAX_URL_CHARS = 2_048;

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
    sections: z
      .array(
        z.object({
          type: z.string().max(200),
          props: z.record(z.string(), z.unknown()),
        }),
      )
      .max(60)
      .optional()
      .describe(
        `The drafted post's sections. Any prop written as \`${IMAGE_SENTINEL}<what it shows>\` is drawn and the address written back in its place, at most ${MAX_BODY_IMAGES} per post. Sentinels left over are blanked, because one reaching a page renders broken. Returned under \`sections\`; omit and only the cover is drawn.`,
      ),
    guidance: z
      .string()
      .max(2_000)
      .default("")
      .describe(
        "Standing instruction folded into every brief, cover and body alike — the illustrator's own editable rule about how this brand's pictures should look.",
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
    sections: z
      .array(
        z.object({
          type: z.string(),
          props: z.record(z.string(), z.unknown()),
        }),
      )
      .describe(
        "The sections given back with their image props filled and every leftover sentinel blanked. Empty when none were passed.",
      ),
    bodyImages: z
      .number()
      .int()
      .describe("Body images drawn, not counting the cover."),
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
        /** Still blanked: a sentinel is wrong whether or not we could draw. */
        sections: (input.sections ?? []).map((section) => ({
          ...section,
          props: clearSentinels(section.props) as Record<string, unknown>,
        })),
        bodyImages: 0,
      };
    }

    const references = await fetchProductPhotos(input.productImages);
    const draw = (prompt: string, alt: string) =>
      painter.paint(
        brief(prompt, input.companyName, input.guidance, references.length),
        alt,
        references,
      );

    const images = await Promise.all(
      input.requests.map(async (request) => ({
        id: request.id,
        url: await draw(request.prompt, request.alt || request.prompt),
      })),
    );

    let budget = MAX_BODY_IMAGES;
    let bodyImages = 0;
    const sections: { type: string; props: Record<string, unknown> }[] = [];
    for (const section of input.sections ?? []) {
      let props = section.props;
      for (const request of sentinelRequests(props)) {
        if (budget <= 0) break;
        budget -= 1;
        const url = await draw(request.prompt, request.prompt);
        if (url) {
          props = withImageAt(props, request.path, url);
          bodyImages += 1;
        }
      }
      sections.push({
        ...section,
        props: clearSentinels(props) as Record<string, unknown>,
      });
    }

    console.info(
      `[BLOG_POST_ILLUSTRATE] ${images.filter((i) => i.url).length}/${images.length} cover(s) and ${bodyImages} body image(s) from ${references.length} reference(s), images ${painter.outcome()}`,
    );

    return {
      images,
      outcome: painter.outcome(),
      referenced: references.length,
      sections,
      bodyImages,
    };
  },
});

/** Attributed, steered, lettering-free — and naming the references, or the model treats them as style and invents the product anyway. */
function brief(
  prompt: string,
  companyName: string,
  guidance: string,
  referenceCount: number,
): string {
  const attribution = companyName ? ` published by ${companyName}` : "";
  const referenced =
    referenceCount > 0
      ? ` The attached ${referenceCount === 1 ? "photograph shows a real product" : `${referenceCount} photographs show real products`} from this brand's catalogue: depict ${referenceCount === 1 ? "that product" : "those products"} as they actually look — shape, colour, proportions and markings — rather than inventing a similar one.`
      : "";
  const steer = guidance.trim() ? ` ${guidance.trim()}` : "";
  return `Editorial photograph for a blog post${attribution}. ${prompt}${referenced}${steer} No text, no lettering, no logo, no watermark anywhere in the image.`;
}
