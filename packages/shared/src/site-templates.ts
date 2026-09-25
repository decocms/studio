import { z } from "zod";
import { DECO_SITES_GITHUB_OWNER } from "./deco-sites-github";

/**
 * The public GitHub template repositories a new site can start from. The id is
 * the wire value; the repository never leaves the server's allowlist, so a
 * caller cannot generate from an arbitrary repo.
 */
export const SITE_TEMPLATES = [
  {
    id: "storefront",
    repo: { owner: DECO_SITES_GITHUB_OWNER, name: "storefront-tanstack" },
  },
  {
    id: "blog",
    repo: { owner: DECO_SITES_GITHUB_OWNER, name: "blog-tanstack" },
  },
] as const;

export type SiteTemplate = (typeof SITE_TEMPLATES)[number];
export type SiteTemplateId = SiteTemplate["id"];

export const SiteTemplateIdSchema = z.enum(["storefront", "blog"]);

export function siteTemplate(id: SiteTemplateId): SiteTemplate {
  const template = SITE_TEMPLATES.find((t) => t.id === id);
  if (!template) throw new Error(`Unknown site template: ${id}`);
  return template;
}

/**
 * Name of the repository a new site is generated into: a lower-case slug, so
 * it also works as a hostname label. GitHub allows up to 100 characters.
 */
export const SiteRepoNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Use lower-case letters, numbers and hyphens, starting and ending with a letter or number",
  );
