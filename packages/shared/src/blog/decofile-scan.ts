/**
 * Finding the blog inside a site's decofile.
 *
 * Deco's blog app stores each record as a block keyed
 * `collections/blog/<kind>/<id>` whose `__resolveType` points at the matching
 * loader. Detection goes by `__resolveType` rather than by key, because how a
 * decofile keys an entry is the site's business and what it resolves to is the
 * app's.
 */
import {
  asRecord,
  type MissingFieldKey,
  missingCategoryFields,
  missingPostFields,
  normalizeTitleKey,
  str,
} from "./fields";

const BLOG_LOADER_RESOLVE_TYPES = {
  post: "blog/loaders/Blogpost.ts",
  author: "blog/loaders/Author.ts",
  category: "blog/loaders/Category.ts",
} as const;

export type BlogKind = "posts" | "authors" | "categories";

export const BLOG_KINDS: readonly BlogKind[] = [
  "posts",
  "authors",
  "categories",
];

export const BLOG_SINGULAR: Record<BlogKind, string> = {
  posts: "post",
  authors: "author",
  categories: "category",
};

export function isBlogKind(id: string): id is BlogKind {
  return (BLOG_KINDS as readonly string[]).includes(id);
}

/** Wrapper field that holds the editable payload for each loader block. */
export const WRAPPER_KEY: Record<BlogKind, "post" | "author" | "category"> = {
  posts: "post",
  authors: "author",
  categories: "category",
};

export const RESOLVE_TYPE_FOR_KIND: Record<BlogKind, string> = {
  posts: BLOG_LOADER_RESOLVE_TYPES.post,
  authors: BLOG_LOADER_RESOLVE_TYPES.author,
  categories: BLOG_LOADER_RESOLVE_TYPES.category,
};

const KIND_FOR_RESOLVE_TYPE: Record<string, BlogKind> = Object.fromEntries(
  Object.entries(RESOLVE_TYPE_FOR_KIND).map(([kind, rt]) => [
    rt,
    kind as BlogKind,
  ]),
);

export interface BlogEntry {
  /** Decofile key (block id), e.g. `collections/blog/posts/abc`. */
  key: string;
  kind: BlogKind;
  /** Human label derived from the payload (title / name). */
  label: string;
  /** Secondary line (slug, email, …). */
  subtitle: string;
  /** Categories only — the record's own slug, for nesting. */
  slug?: string;
  /** Categories only — the slug of the parent category, when nested. */
  parentSlug?: string;
  /** Required fields this record is missing; empty when it is complete. */
  missing: MissingFieldKey[];
  /** Another record of the same kind carries this same name/title. */
  duplicateName?: boolean;
}

function kindOfResolveType(resolveType: unknown): BlogKind | null {
  return typeof resolveType === "string"
    ? (KIND_FOR_RESOLVE_TYPE[resolveType] ?? null)
    : null;
}

function entryLabelAndSubtitle(
  kind: BlogKind,
  payload: Record<string, unknown>,
): Omit<BlogEntry, "key" | "kind" | "duplicateName"> {
  switch (kind) {
    case "posts":
      return {
        label: str(payload.title) || "Untitled post",
        subtitle: str(payload.slug),
        missing: missingPostFields(payload),
      };
    case "authors":
      return {
        label: str(payload.name) || "Unnamed author",
        subtitle: str(payload.email),
        missing: [],
      };
    case "categories":
      return {
        label: str(payload.name) || "Unnamed category",
        subtitle: str(payload.slug),
        slug: str(payload.slug),
        parentSlug: str(payload.parentSlug),
        missing: missingCategoryFields(payload),
      };
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unhandled blog kind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Single-pass scan that returns all blog entries grouped by kind.
 * Use this in hot render paths instead of calling extractBlogEntries per kind.
 */
export function scanBlogEntries(
  decofile: Record<string, unknown>,
): Record<BlogKind, BlogEntry[]> {
  const result: Record<BlogKind, BlogEntry[]> = {
    posts: [],
    authors: [],
    categories: [],
  };
  const nameKeys: Array<{ entry: BlogEntry; key: string }> = [];
  for (const [key, value] of Object.entries(decofile)) {
    const obj = asRecord(value);
    if (!obj) continue;
    const kind = kindOfResolveType(obj.__resolveType);
    if (!kind) continue;
    const payload = asRecord(obj[WRAPPER_KEY[kind]]) ?? {};
    const entry: BlogEntry = {
      key,
      kind,
      ...entryLabelAndSubtitle(kind, payload),
    };
    result[kind].push(entry);
    // The RAW name, not the label: two untitled records share its fallback.
    nameKeys.push({
      entry,
      key: normalizeTitleKey(str(payload[kind === "posts" ? "title" : "name"])),
    });
  }
  markDuplicateNames(nameKeys);
  for (const kind of BLOG_KINDS) {
    result[kind].sort((a, b) => a.label.localeCompare(b.label));
  }
  return result;
}

/** Flag every entry whose non-empty name key is shared within its own kind. */
function markDuplicateNames(
  entries: Array<{ entry: BlogEntry; key: string }>,
): void {
  const counts = new Map<string, number>();
  for (const { entry, key } of entries) {
    if (!key) continue;
    const scoped = `${entry.kind}:${key}`;
    counts.set(scoped, (counts.get(scoped) ?? 0) + 1);
  }
  for (const { entry, key } of entries) {
    if (key && (counts.get(`${entry.kind}:${key}`) ?? 0) > 1) {
      entry.duplicateName = true;
    }
  }
}

/** Extract all blog records of a given kind, sorted by label. */
function extractBlogEntries(
  decofile: Record<string, unknown>,
  kind: BlogKind,
): BlogEntry[] {
  return scanBlogEntries(decofile)[kind];
}

/** All records of a kind paired with their editable payload. */
export function listBlogPayloads(
  decofile: Record<string, unknown>,
  kind: BlogKind,
): Array<{ key: string; payload: Record<string, unknown> }> {
  return extractBlogEntries(decofile, kind).map((entry) => ({
    key: entry.key,
    payload: getBlogPayload(asRecord(decofile[entry.key]) ?? undefined, kind),
  }));
}

/**
 * One frozen empty payload, so an absent block answers with the same object
 * every time. `useAutosave` compares `initial` by reference to spot an edit
 * made elsewhere; a fresh `{}` per render reads as a change and loops. Frozen
 * because every consumer spreads or clones it, and none mutates.
 */
export const EMPTY_PAYLOAD: Record<string, unknown> = Object.freeze({});

/** Read the editable payload (the `post`/`author`/`category` object). */
export function getBlogPayload(
  block: Record<string, unknown> | undefined,
  kind: BlogKind,
): Record<string, unknown> {
  if (!block) return EMPTY_PAYLOAD;
  return asRecord(block[WRAPPER_KEY[kind]]) ?? EMPTY_PAYLOAD;
}

/** Rebuild the full block from an edited payload, preserving id + type. */
export function buildBlogBlock(
  key: string,
  kind: BlogKind,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name: key,
    __resolveType: RESOLVE_TYPE_FOR_KIND[kind],
    [WRAPPER_KEY[kind]]: payload,
  };
}

// ------------------ Post relations (authors/categories picker) ------------------
