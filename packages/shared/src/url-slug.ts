import { z } from "zod";
import { slugify } from "./utils/slugify";

/**
 * The `url_slug` that names a project or connection in a Studio URL
 * (`/$org/projects/<slug>/apps/<slug>/...`). Unique per organization and
 * stable across renames; the derived `connections.slug` is a grouping key and
 * is neither.
 *
 * Underscores are not allowed, so a slug can never look like a prefixed id
 * (`vir_…`, `conn_…`) and a URL segment is unambiguous.
 */
export const URL_SLUG_MIN = 2;
export const URL_SLUG_MAX = 64;

const URL_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Words that read as routes rather than names. */
const RESERVED_URL_SLUGS: ReadonlySet<string> = new Set([
  "new",
  "edit",
  "settings",
  "apps",
  "projects",
  "connections",
]);

export const UrlSlugSchema = z
  .string()
  .min(URL_SLUG_MIN)
  .max(URL_SLUG_MAX)
  .regex(
    URL_SLUG_PATTERN,
    "Use lowercase letters, digits, and single hyphens between them",
  )
  .refine((slug) => !slug.includes("--"), "Use single hyphens")
  .refine((slug) => !RESERVED_URL_SLUGS.has(slug), "This slug is reserved");

export function isValidUrlSlug(value: unknown): value is string {
  return UrlSlugSchema.safeParse(value).success;
}

/** The default slug for a name, or `fallback` when the name has none. */
export function urlSlugBase(name: string | null | undefined, fallback: string) {
  const slug = slugify(name ?? "")
    .slice(0, URL_SLUG_MAX)
    .replace(/-+$/, "");
  return isValidUrlSlug(slug) ? slug : fallback;
}

/** `base`, `base-2`, `base-3`, …, truncating `base` so the result fits. */
export function urlSlugCandidate(base: string, attempt: number): string {
  if (attempt <= 1) return base;
  const suffix = `-${attempt}`;
  return `${base.slice(0, URL_SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
}
