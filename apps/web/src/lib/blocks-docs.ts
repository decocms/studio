/**
 * The Deco Blocks docs (deco-sites/docs-tanstack, published at docs.decocms.com).
 * Every docs link the site editor shows is built from this one base, so a
 * move changes only this line.
 */
const BLOCKS_DOCS_URL = "https://docs.decocms.com/storefront/blocks";

export const blocksDocs = {
  quickstart: `${BLOCKS_DOCS_URL}/next/quickstart`,
  siteEditor: `${BLOCKS_DOCS_URL}/next/site-editor#edit-on-your-machine`,
  serve: `${BLOCKS_DOCS_URL}/next/cli#deco-serve`,
  schema: `${BLOCKS_DOCS_URL}/next/cli#deco-schema-and-deco-content`,
  troubleshooting: `${BLOCKS_DOCS_URL}/next/troubleshooting#site-editor`,
} as const;

/**
 * The `deco-site-workflow` agent skill (in the Blocks repo; `npx deco skills
 * install` copies it into a site). Its `references/schema.md` is what the
 * schema banner's prompt sends a coding agent to.
 */
export const DECO_SITE_WORKFLOW_SKILL_URL =
  "https://github.com/decocms/blocks/tree/main/.agents/skills/deco-site-workflow";
