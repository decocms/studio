import type { PageEntry } from "@/components/sections-editor/page-list";
import { normalizePagePath } from "@/components/sections-editor/page-path-utils";

/**
 * One row of the analytics `pageAudience` panel: a URL path, its visitors
 * and, when the read surface sends them, its pageviews. ClickHouse JSON
 * quotes 64-bit integers, so a count may arrive as a string.
 */
interface AudienceRow {
  k: string;
  n: number | string;
  pv?: number | string;
}

export interface PathAudience {
  path: string;
  visitors: number;
  /** Absent when the read surface sent no pageviews for the path. */
  pageviews?: number;
}

export interface PageAudience {
  page: PageEntry;
  /** A path with `:param`, `*` or an optional group: it serves many URLs. */
  template: boolean;
  visitors: number;
  pageviews?: number;
  /** The paths this page serves, most visitors first. */
  urls: PathAudience[];
}

export interface PagesAudience {
  /** Every CMS page, with or without traffic. */
  pages: PageAudience[];
  /** Paths with traffic that no CMS page serves (checkout, proxied routes…). */
  other: PathAudience[];
  /** Whether any row carried pageviews (else the column has nothing to say). */
  hasPageviews: boolean;
}

const count = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * The `pages` view's rows, one per normalized path: `pageAudience` carries
 * visitors (and `pv` pageviews when sent); a `pages` panel in the same
 * payload, if present, fills pageviews by path. Malformed rows are dropped.
 */
export function readPathAudience(payload: unknown): PathAudience[] {
  const data = (payload ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(data.pageAudience)
    ? (data.pageAudience as AudienceRow[])
    : [];
  const pageviews = new Map<string, number>();
  if (Array.isArray(data.pages)) {
    for (const row of data.pages as AudienceRow[]) {
      const n = count(row?.n);
      if (typeof row?.k === "string" && n !== undefined) {
        const path = normalizePagePath(row.k);
        pageviews.set(path, (pageviews.get(path) ?? 0) + n);
      }
    }
  }
  const byPath = new Map<string, PathAudience>();
  for (const row of rows) {
    const visitors = count(row?.n);
    if (typeof row?.k !== "string" || visitors === undefined) continue;
    const path = normalizePagePath(row.k);
    const pv = count(row.pv) ?? pageviews.get(path);
    const current = byPath.get(path);
    if (!current) {
      byPath.set(path, { path, visitors, pageviews: pv });
      continue;
    }
    // `/a` and `/a/` are one page: add them up.
    current.visitors += visitors;
    if (count(row.pv) !== undefined) {
      current.pageviews = (current.pageviews ?? 0) + (count(row.pv) ?? 0);
    }
  }
  return [...byPath.values()].sort((a, b) => b.visitors - a.visitors);
}

/** `{x}?` optional group, `:param`, or the `*` catch-all of a page path template. */
const TEMPLATE_TOKEN_RE = /\{([^{}]*)\}\?|:[A-Za-z0-9_-]+|\*/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function templateSource(template: string): string {
  let source = "";
  let last = 0;
  for (const match of template.matchAll(TEMPLATE_TOKEN_RE)) {
    source += escapeRegExp(template.slice(last, match.index));
    source +=
      match[1] !== undefined
        ? `(?:${templateSource(match[1])})?`
        : match[0] === "*"
          ? ".*"
          : "[^/]+";
    last = match.index + match[0].length;
  }
  return source + escapeRegExp(template.slice(last));
}

const sum = (rows: PathAudience[], key: "visitors" | "pageviews") =>
  rows.reduce((total, row) => total + (row[key] ?? 0), 0);

/**
 * Attribute each analytics path to the ONE page that serves it, like the
 * router: a static page owns its exact path; otherwise the matching template
 * with the most literal characters wins, so `/:slug/p` beats the `/*`
 * catch-all. A template's figure is the sum over its paths, so a visitor who
 * saw three products counts three times. Paths no page serves land in `other`.
 */
export function groupPathsByPage(
  pages: PageEntry[],
  paths: PathAudience[],
): PagesAudience {
  const byPath = new Map<string, PageEntry>();
  const templates: { page: PageEntry; re: RegExp; literal: number }[] = [];
  const isTemplate = new Set<string>();
  // Same tie-break as `findPageForPath`: the first key wins a shared path.
  for (const page of [...pages].sort((a, b) => a.key.localeCompare(b.key))) {
    const path = normalizePagePath(page.path);
    if (path.match(TEMPLATE_TOKEN_RE)) {
      isTemplate.add(page.key);
      templates.push({
        page,
        re: new RegExp(`^${templateSource(path)}$`),
        literal: path.replace(TEMPLATE_TOKEN_RE, "").length,
      });
    } else if (!byPath.has(path)) {
      byPath.set(path, page);
    }
  }
  templates.sort((a, b) => b.literal - a.literal);

  const urls = new Map<string, PathAudience[]>();
  const other: PathAudience[] = [];
  for (const row of paths) {
    const page =
      byPath.get(row.path) ?? templates.find((t) => t.re.test(row.path))?.page;
    if (!page) {
      other.push(row);
      continue;
    }
    const list = urls.get(page.key) ?? [];
    list.push(row);
    urls.set(page.key, list);
  }

  const hasPageviews = paths.some((row) => row.pageviews !== undefined);
  return {
    pages: pages.map((page) => {
      const list = (urls.get(page.key) ?? []).sort(
        (a, b) => b.visitors - a.visitors,
      );
      return {
        page,
        template: isTemplate.has(page.key),
        visitors: sum(list, "visitors"),
        pageviews: hasPageviews ? sum(list, "pageviews") : undefined,
        urls: list,
      };
    }),
    other,
    hasPageviews,
  };
}

export type PagesSortKey = "name" | "visitors" | "pageviews";

/** Sort by one column; ties (and pages without traffic) keep name order. */
export function sortPageAudience(
  rows: PageAudience[],
  key: PagesSortKey,
  dir: 1 | -1,
): PageAudience[] {
  const byName = (a: PageAudience, b: PageAudience) =>
    a.page.name.localeCompare(b.page.name);
  return [...rows].sort((a, b) =>
    key === "name"
      ? byName(a, b) * dir
      : ((a[key] ?? 0) - (b[key] ?? 0)) * dir || byName(a, b),
  );
}
