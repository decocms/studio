import { z } from "zod";
import {
  BRAND_EVIDENCE_MAX_BLOCKS,
  CATALOG_EVIDENCE_MAX_CHARS,
  SEO_EVIDENCE_MAX_ENTRIES,
  SEO_EVIDENCE_MAX_ENTRY_CHARS,
} from "@decocms/shared/blog-brand-evidence";

/** Caps on what a client may send — the request body is a trust boundary.
 *  Counts are shared with the client's sampler so the two cannot drift. */
const MAX_BLOCK_CHARS = 12_000;

export const EvidenceBlocksSchema = z
  .array(
    z.object({
      key: z
        .string()
        .max(512)
        .describe("Decofile block key, e.g. collections/blog/posts/abc"),
      content: z
        .string()
        .max(MAX_BLOCK_CHARS)
        .describe("The block's JSON, serialized"),
    }),
  )
  .min(1)
  .max(BRAND_EVIDENCE_MAX_BLOCKS)
  .describe(
    "Blocks to read, most telling first — existing blogposts, then categories, then pages (home and institutional before commerce).",
  );

export const EvidenceSeoSchema = z
  .array(
    z.object({
      key: z
        .string()
        .max(512)
        .describe("`site` for the inherited default, otherwise the page path"),
      content: z.string().max(SEO_EVIDENCE_MAX_ENTRY_CHARS),
    }),
  )
  .max(SEO_EVIDENCE_MAX_ENTRIES)
  .optional()
  .describe(
    "The site's SEO titles and descriptions, the site-wide default first. This is a site's most deliberately written copy — one line per page, rewritten until a team agreed it says what they want a stranger to think they are.",
  );

export const EvidenceCatalogSchema = z
  .string()
  .max(CATALOG_EVIDENCE_MAX_CHARS)
  .optional()
  .describe(
    "The store's category tree and a sample of its products, as markdown. Absent when the site is not a store, or its catalog could not be read.",
  );

export interface EvidenceInput {
  blocks: { key: string; content: string }[];
  seo?: { key: string; content: string }[];
  catalog?: string;
}

/**
 * The evidence as one prompt, in labelled sections.
 *
 * Labels are the point: the same title string read as "a page's SEO" and as
 * "a line of copy somewhere in a block" supports different conclusions, and
 * before this the model could not tell which it was holding.
 */
export function renderEvidence(input: EvidenceInput): string {
  const sections: string[] = [];

  if (input.seo?.length) {
    const body = input.seo
      .map((entry) => `## ${entry.key}\n\n${entry.content}`)
      .join("\n\n");
    sections.push(`# The site's SEO\n\n${body}`);
  }

  sections.push(
    `# The site's own content\n\n${input.blocks
      .map((block) => `## Block: ${block.key}\n\n${block.content}`)
      .join("\n\n---\n\n")}`,
  );

  if (input.catalog?.trim()) {
    sections.push(`# The store's catalog\n\n${input.catalog}`);
  }

  return sections.join("\n\n---\n\n");
}
