/**
 * The Deco Blocks docs (decocms/blocks `docs/`, published to GitHub Pages).
 * Every docs link the site editor shows is built from this one base, so a
 * move to a custom domain changes only this line.
 */
export const BLOCKS_DOCS_URL = "https://decocms.github.io/blocks";

export const blocksDocs = {
  quickstart: `${BLOCKS_DOCS_URL}/next/quickstart`,
  siteEditor: `${BLOCKS_DOCS_URL}/next/site-editor#edit-on-your-machine`,
  serve: `${BLOCKS_DOCS_URL}/next/cli#deco-serve`,
  schema: `${BLOCKS_DOCS_URL}/next/cli#deco-schema-and-deco-content`,
  troubleshooting: `${BLOCKS_DOCS_URL}/next/troubleshooting#site-editor`,
} as const;
