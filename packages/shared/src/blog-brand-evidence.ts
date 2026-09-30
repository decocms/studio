/**
 * The wire contract for the brand extract's evidence input.
 *
 * Shared because the two ends disagreed: the sampler budgeted only by total
 * characters while the schema also capped the count, so a site of many short
 * blocks stayed under the character budget, sent hundreds of them, and had the
 * whole call rejected — on exactly the content-rich sites the feature is for.
 * Every cap a sampler honours belongs here for that reason.
 */
export const BRAND_EVIDENCE_MAX_BLOCKS = 60;

/** SEO entries sent alongside the blocks: the site default, then per page. */
export const SEO_EVIDENCE_MAX_ENTRIES = 25;

/** Total chars of SEO evidence, reserved out of the block budget. */
export const SEO_EVIDENCE_MAX_CHARS = 8_000;

/** One SEO entry — a title and a description, never a whole page. */
export const SEO_EVIDENCE_MAX_ENTRY_CHARS = 2_000;

/** Chars reserved for the catalog sample, which is fetched, not sampled. */
export const CATALOG_EVIDENCE_MAX_CHARS = 8_000;
