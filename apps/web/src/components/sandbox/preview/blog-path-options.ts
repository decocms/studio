import {
  extractPathParams,
  fillPathTemplate,
  splitPathTemplate,
} from "@/components/sections-editor/page-path-utils";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import {
  type BlogKind,
  postStatus,
  scanBlogEntries,
  WRAPPER_KEY,
} from "@/components/sandbox/content/blog/blog-data";
import {
  blogCategoryPath,
  blogPostPath,
} from "@/components/sandbox/content/blog/blog-preview-url";
import { valueFromEntityUrl } from "./path-param-picker";

/** A blog record a dynamic route can preview, with every route param filled. */
export interface BlogPathOption {
  label: string;
  /** Value for each param of the route, all from the same record. */
  values: Record<string, string>;
}

/** The blog app has no author route prop, so the author page is found by name. */
const AUTHOR_PARAM_RE = /^(?:autor|author|authorSlug)$/;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

/**
 * Blog posts, categories and authors whose site path fits `template`, newest
 * post first, so a blog route opens on a real record instead of its 404.
 *
 * Every param is read from one record's path, so `:categoria` and `:slug` stay
 * a pair the site serves. Matching is by route shape, not param names: the
 * blog app may say `:category` where the page says `:categoria`. Routes with a
 * catch-all or a param right after `/` get nothing, since a store's PLP
 * template matches any blog path too.
 */
export function blogPathOptions(
  decofile: Record<string, unknown>,
  template: string,
  meta: LiveMeta | null | undefined,
  today: string = new Date().toISOString().slice(0, 10),
): BlogPathOption[] {
  const params = extractPathParams(template);
  const [first] = splitPathTemplate(template);
  if (
    params.length === 0 ||
    params.includes("*") ||
    first?.type !== "text" ||
    first.text === "/"
  ) {
    return [];
  }

  const entries = scanBlogEntries(decofile);
  const payloads = (kind: BlogKind) =>
    entries[kind].map((entry) => ({
      label: entry.label,
      data: asRecord(asRecord(decofile[entry.key])[WRAPPER_KEY[kind]]),
    }));

  const candidates: { label: string; path: string | null }[] = [];
  // Only posts the site renders today: a scheduled one still answers 404.
  const posts = payloads("posts")
    .filter(
      ({ data }) =>
        postStatus(data) === "published" &&
        str(data.date).slice(0, 10) <= today,
    )
    .sort((a, b) => str(b.data.date).localeCompare(str(a.data.date)));
  for (const { label, data } of posts) {
    candidates.push({ label, path: blogPostPath(decofile, data, meta) });
  }
  for (const { label, data } of payloads("categories")) {
    candidates.push({ label, path: blogCategoryPath(decofile, data, meta) });
  }
  const authorParam = params.find((name) => AUTHOR_PARAM_RE.test(name));
  if (authorParam) {
    for (const { label, data } of payloads("authors")) {
      const slug = str(data.slug);
      candidates.push({
        label,
        path: slug ? fillPathTemplate(template, { [authorParam]: slug }) : null,
      });
    }
  }

  const options: BlogPathOption[] = [];
  const seen = new Set<string>();
  for (const { label, path } of candidates) {
    if (!path) continue;
    const values: Record<string, string> = {};
    for (const name of params) {
      const value = valueFromEntityUrl(path, template, name);
      if (!value) break;
      values[name] = value;
    }
    if (Object.keys(values).length !== params.length) continue;
    const filled = fillPathTemplate(template, values);
    if (seen.has(filled)) continue;
    seen.add(filled);
    options.push({ label, values });
  }
  return options;
}
