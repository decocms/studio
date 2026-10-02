/**
 * Blog categories nest through `parentSlug` — the CMS-side mirror of the blog
 * app's `blog/core/categoryTree.ts`, carrying only what the list and the
 * parent picker need.
 *
 * Records come from a decofile a human edits, so a `parentSlug` may point at
 * nothing, at itself, or around a cycle. Every walk is bounded by a visited
 * set and treats a broken link as a root instead of throwing: a category must
 * never disappear from the list because its parent reference is wrong, which
 * is exactly when the author needs to find it and fix it.
 *
 * {@link MAX_CATEGORY_DEPTH} bounds the walks that mirror what the site
 * renders — the layout and the breadcrumb. `descendantSlugs` deliberately has
 * no cap: it answers "may this be a parent", and a descendant past the cap is
 * still a descendant.
 */
import type { BlogEntry } from "./blog-data";

/** Matches the blog app's ceiling. Deeper chains are flattened to roots. */
export const MAX_CATEGORY_DEPTH = 4;

/** Slug -> entry. First entry wins when a slug is duplicated. */
function indexBySlug(entries: BlogEntry[]): Map<string, BlogEntry> {
  const index = new Map<string, BlogEntry>();
  for (const entry of entries) {
    if (entry.slug && !index.has(entry.slug)) index.set(entry.slug, entry);
  }
  return index;
}

/**
 * The parent entry of `entry`, or undefined when it is (or acts as) a root.
 * A duplicated slug can index back to `entry` itself; that is a root too.
 */
function parentOf(
  entry: BlogEntry,
  index: Map<string, BlogEntry>,
): BlogEntry | undefined {
  const parentSlug = entry.parentSlug;
  if (!parentSlug || parentSlug === entry.slug) return undefined;
  const parent = index.get(parentSlug);
  return parent === entry ? undefined : parent;
}

/**
 * Ancestor chain of `slug`, root first and the category itself last — the
 * breadcrumb sequence. Returns the lone entry when it is a root, and an empty
 * array when the slug is unknown. A cycle or an over-deep chain truncates at
 * the point it is detected rather than returning nothing: this feeds a
 * subtitle, where a partial path still orients the author.
 */
export function categoryAncestors(
  slug: string,
  entries: BlogEntry[],
): BlogEntry[] {
  const index = indexBySlug(entries);
  const chain: BlogEntry[] = [];
  const seen = new Set<string>();
  let current = index.get(slug);

  while (current && !seen.has(current.slug ?? "")) {
    seen.add(current.slug ?? "");
    chain.push(current);
    if (chain.length >= MAX_CATEGORY_DEPTH) break;
    current = parentOf(current, index);
  }

  return chain.reverse();
}

/** Children indexed by parent slug, name-sorted, skipping roots. */
function childrenIndex(
  entries: BlogEntry[],
  index: Map<string, BlogEntry>,
): Map<string, BlogEntry[]> {
  const children = new Map<string, BlogEntry[]>();
  for (const entry of entries) {
    const parent = parentOf(entry, index);
    if (!parent?.slug) continue;
    const siblings = children.get(parent.slug);
    siblings ? siblings.push(entry) : children.set(parent.slug, [entry]);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => a.label.localeCompare(b.label));
  }
  return children;
}

/**
 * Every category below `slug`, excluding `slug` itself. Breadth-first with a
 * visited set, so a cycle yields a finite set. Used by the parent picker to
 * refuse the options that would close a loop.
 */
export function descendantSlugs(
  slug: string,
  entries: BlogEntry[],
): Set<string> {
  const children = childrenIndex(entries, indexBySlug(entries));
  const seen = new Set<string>([slug]);
  let frontier = [slug];

  // No depth cap here, unlike the layout walk: a descendant past the cap is
  // still a descendant, and leaving it out of the set lets the parent picker
  // offer it and close a cycle. The visited set already bounds the walk.
  while (frontier.length) {
    const next: string[] = [];
    for (const parent of frontier) {
      for (const child of children.get(parent) ?? []) {
        if (child.slug && !seen.has(child.slug)) {
          seen.add(child.slug);
          next.push(child.slug);
        }
      }
    }
    frontier = next;
  }

  seen.delete(slug);
  return seen;
}

export interface CategoryTreeRow {
  entry: BlogEntry;
  /** 0 for a root; the indent level of the row. */
  depth: number;
}

/**
 * `entries` laid out depth-first, roots and siblings alphabetical by label.
 *
 * Everything the walk cannot place under a parent — a missing slug, a dangling
 * or self-referencing `parentSlug`, a member of a cycle, a child past
 * {@link MAX_CATEGORY_DEPTH} — is emitted as a root, so the output always
 * contains every input exactly once.
 */
export function orderCategoryTree(entries: BlogEntry[]): CategoryTreeRow[] {
  const index = indexBySlug(entries);
  const children = childrenIndex(entries, index);
  const placed = new Set<BlogEntry>();
  const rows: CategoryTreeRow[] = [];

  const walk = (entry: BlogEntry, depth: number) => {
    if (placed.has(entry)) return;
    placed.add(entry);
    rows.push({ entry, depth });
    if (depth + 1 >= MAX_CATEGORY_DEPTH) return;
    for (const child of children.get(entry.slug ?? "") ?? []) {
      walk(child, depth + 1);
    }
  };

  const roots = entries
    .filter((e) => !parentOf(e, index))
    .sort((a, b) => a.label.localeCompare(b.label));
  for (const root of roots) walk(root, 0);

  // Whatever is left sits in a cycle or below the depth cap.
  for (const entry of entries) walk(entry, 0);

  return rows;
}
