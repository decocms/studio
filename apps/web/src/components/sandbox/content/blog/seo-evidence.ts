/**
 * SEO as brand evidence.
 *
 * A site's SEO titles and descriptions are its most deliberately written copy:
 * one line per page, rewritten until a team agrees it says what they want a
 * stranger to think they are. That makes them the densest voice evidence a
 * site has, and until now the extract never asked for them — the site-level
 * default lives on `site/apps/site.ts`, which is neither a post nor a page, so
 * no evidence tier ever reached it.
 *
 * Reads only; the editor at `sections-editor/seo-editor.tsx` owns writing.
 */

import {
  SEO_EVIDENCE_MAX_CHARS,
  SEO_EVIDENCE_MAX_ENTRIES,
  SEO_EVIDENCE_MAX_ENTRY_CHARS,
} from "@decocms/shared/blog-brand-evidence";
import { findSiteSeoEntry } from "@/components/sections-editor/seo-block";
import {
  isSeoEnabled,
  unwrapSeoConfig,
} from "@/components/sections-editor/seo-lazy-render";
import { getSeoFormMode } from "@/components/sections-editor/seo-form-mode";
import { extractPathParams } from "@/components/sections-editor/page-path-utils";
import type { PageEntry } from "@/components/sections-editor/page-list";

/**
 * The SEO props that carry voice. `image`, `favicon`, `themeColor` and
 * `noIndexing` say nothing about how a brand writes.
 */
const SEO_PROSE_KEYS = [
  "title",
  "titleTemplate",
  "description",
  "descriptionTemplate",
] as const;

export interface SeoEvidenceEntry {
  /** `site` for the inherited default, otherwise the page's path. */
  key: string;
  content: string;
}

/**
 * What a page is for, which decides how much its SEO is worth reading.
 *
 * Institutional copy is written once, by hand, about the brand. A PDP or PLP
 * title is a template with a product name substituted in, so the thousandth
 * one teaches nothing the first did not.
 */
export type PageRole = "home" | "institutional" | "commerce";

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** One SEO object rendered as `prop: value` lines, or "" when it says nothing. */
export function seoProseFor(raw: unknown): string {
  if (!isSeoEnabled(raw)) return "";
  const config = unwrapSeoConfig(raw);
  if (!config) return "";
  const lines: string[] = [];
  for (const key of SEO_PROSE_KEYS) {
    const value = str(config[key]);
    if (value) lines.push(`${key}: ${value}`);
  }
  return lines.join("\n").slice(0, SEO_EVIDENCE_MAX_ENTRY_CHARS);
}

/**
 * A page's role, from its own SEO section type first — `SeoPDP*`/`SeoPLP*` is
 * the strongest commerce marker a decofile carries — then from the path shape,
 * since a path with a `:param` or a `*` is a template serving many products.
 */
export function pageRole(
  decofile: Record<string, unknown>,
  page: PageEntry,
): PageRole {
  const block = decofile[page.key];
  const config =
    block && typeof block === "object"
      ? unwrapSeoConfig((block as Record<string, unknown>).seo)
      : null;
  const resolveType = str(config?.__resolveType);
  if (resolveType) {
    const mode = getSeoFormMode(resolveType);
    if (mode === "pdp" || mode === "plp") return "commerce";
  }
  if (extractPathParams(page.path).length > 0) return "commerce";
  return page.path === "/" ? "home" : "institutional";
}

/**
 * The SEO worth reading, most telling first: the site default (the template
 * every page inherits), then home, then institutional pages, then at most two
 * commerce pages as a sample of the templated shape.
 *
 * Deduped on rendered content, which is what pays for itself here: a templated
 * PDP title is byte-identical across every product page on the site.
 */
export function selectSeoEvidence(
  decofile: Record<string, unknown>,
  pages: PageEntry[],
): SeoEvidenceEntry[] {
  const entries: SeoEvidenceEntry[] = [];
  const seen = new Set<string>();
  let remaining = SEO_EVIDENCE_MAX_CHARS;

  const push = (key: string, content: string) => {
    if (!content || seen.has(content)) return;
    if (entries.length >= SEO_EVIDENCE_MAX_ENTRIES) return;
    if (content.length > remaining) return;
    seen.add(content);
    entries.push({ key, content });
    remaining -= content.length;
  };

  const site = findSiteSeoEntry(decofile);
  if (site) push("site", seoProseFor(site.seoData));

  const byRole: Record<PageRole, PageEntry[]> = {
    home: [],
    institutional: [],
    commerce: [],
  };
  for (const page of pages) byRole[pageRole(decofile, page)].push(page);

  const ordered = [
    ...byRole.home,
    ...byRole.institutional,
    ...byRole.commerce.slice(0, 2),
  ];
  for (const page of ordered) {
    const block = decofile[page.key];
    if (!block || typeof block !== "object") continue;
    push(page.path, seoProseFor((block as Record<string, unknown>).seo));
  }

  return entries;
}
