/**
 * The Deco Blocks docs (deco-sites/docs-tanstack, published at docs.decocms.com).
 * Every docs link the site editor shows is built from this one base, so a
 * move changes only this line.
 */
export const BLOCKS_DOCS_URL = "https://docs.decocms.com/storefront/blocks";

export const blocksDocs = {
  quickstart: `${BLOCKS_DOCS_URL}/next/quickstart`,
  siteEditor: `${BLOCKS_DOCS_URL}/next/site-editor#edit-on-your-machine`,
  serve: `${BLOCKS_DOCS_URL}/next/cli#deco-serve`,
  schema: `${BLOCKS_DOCS_URL}/next/cli#deco-schema-and-deco-content`,
  troubleshooting: `${BLOCKS_DOCS_URL}/next/troubleshooting#site-editor`,
} as const;
