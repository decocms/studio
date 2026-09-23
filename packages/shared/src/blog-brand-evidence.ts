/**
 * The wire contract for `BLOG_BRAND_EXTRACT`'s `blocks` input.
 *
 * Shared because the two ends disagreed: the sampler budgeted only by total
 * characters while the schema also capped the count, so a site of many short
 * blocks stayed under the character budget, sent hundreds of them, and had the
 * whole call rejected — on exactly the content-rich sites the feature is for.
 */
export const BRAND_EVIDENCE_MAX_BLOCKS = 60;
