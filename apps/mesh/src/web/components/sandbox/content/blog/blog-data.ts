/**
 * Pure helpers for the Blog content collections (Posts, Authors,
 * Categories). Deco's blog app stores each record as a decofile block
 * keyed `collections/blog/<kind>/<id>` whose `__resolveType` points at the
 * matching loader. We detect by `__resolveType` (robust to however the
 * decofile keys the entry) and edit the wrapper object in place.
 *
 * On-disk, block files are URL-encoded: the block id
 * `collections/blog/posts/abc` lives at
 * `.deco/blocks/collections%2Fblog%2Fposts%2Fabc.json`. So writes must
 * encode the key into the filename — see `blogBlockFilePath`.
 */
import type { LiveMeta } from "@/web/components/sections-editor/resolve-schema";
import { resolveBlockSchemaMetadata } from "@/web/components/sections-editor/resolve-schema";

const BLOG_LOADER_RESOLVE_TYPES = {
  post: "blog/loaders/Blogpost.ts",
  author: "blog/loaders/Author.ts",
  category: "blog/loaders/Category.ts",
} as const;

/** Prefix every blog content block (Paragraph, Heading, …) shares. */
const BLOG_BLOCK_PREFIX = "blog/sections/blocks/";

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
const WRAPPER_KEY: Record<BlogKind, "post" | "author" | "category"> = {
  posts: "post",
  authors: "author",
  categories: "category",
};

const RESOLVE_TYPE_FOR_KIND: Record<BlogKind, string> = {
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
}

function kindOfResolveType(resolveType: unknown): BlogKind | null {
  return typeof resolveType === "string"
    ? (KIND_FOR_RESOLVE_TYPE[resolveType] ?? null)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function entryLabelAndSubtitle(
  kind: BlogKind,
  payload: Record<string, unknown>,
): { label: string; subtitle: string } {
  switch (kind) {
    case "posts":
      return {
        label: str(payload.title) || "Untitled post",
        subtitle: str(payload.slug),
      };
    case "authors":
      return {
        label: str(payload.name) || "Unnamed author",
        subtitle: str(payload.email),
      };
    case "categories":
      return {
        label: str(payload.name) || "Unnamed category",
        subtitle: str(payload.slug),
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
  for (const [key, value] of Object.entries(decofile)) {
    const obj = asRecord(value);
    if (!obj) continue;
    const kind = kindOfResolveType(obj.__resolveType);
    if (!kind) continue;
    const payload = asRecord(obj[WRAPPER_KEY[kind]]) ?? {};
    const { label, subtitle } = entryLabelAndSubtitle(kind, payload);
    result[kind].push({ key, kind, label, subtitle });
  }
  for (const kind of BLOG_KINDS) {
    result[kind].sort((a, b) => a.label.localeCompare(b.label));
  }
  return result;
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

/** Read the editable payload (the `post`/`author`/`category` object). */
export function getBlogPayload(
  block: Record<string, unknown> | undefined,
  kind: BlogKind,
): Record<string, unknown> {
  if (!block) return {};
  return asRecord(block[WRAPPER_KEY[kind]]) ?? {};
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

/**
 * On-disk block filename. Deco encodes the block id, so slashes become
 * `%2F`. `encodeURIComponent` reproduces deco's exact scheme (verified
 * against existing `collections%2Fblog%2F…` files).
 */
export function blogBlockFilePath(key: string): string {
  return `.deco/blocks/${encodeURIComponent(key)}.json`;
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

/** Fresh `collections/blog/<kind>/<id>` key not present in the decofile. */
export function generateBlogKey(
  decofile: Record<string, unknown>,
  kind: BlogKind,
): string {
  const key = `collections/blog/${kind}/${randomHex(12)}`;
  if (!Object.hasOwn(decofile, key)) return key;
  throw new Error("Could not generate a unique blog block key");
}

/** Default payload for a freshly created record. */
export function emptyBlogPayload(kind: BlogKind): Record<string, unknown> {
  switch (kind) {
    case "posts":
      return {
        title: "Untitled post",
        excerpt: "",
        slug: `untitled-${randomHex(8)}`,
        date: new Date().toISOString().slice(0, 10),
        image: "",
        authors: [],
        categories: [],
        sections: [],
      };
    case "authors":
      return {
        name: "New author",
        email: "",
        jobTitle: "",
        company: "",
        avatar: "",
      };
    case "categories":
      return { name: "New category", slug: `category-${randomHex(8)}` };
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unhandled blog kind: ${String(_exhaustive)}`);
    }
  }
}

export interface BlogBlockType {
  resolveType: string;
  title: string;
  description?: string;
  icon?: string;
}

/**
 * Discover the content block types a post can contain
 * (`blog/sections/blocks/*`) from the live manifest, with title/icon
 * metadata for the inserter UI.
 */
export function discoverBlogBlockTypes(meta: LiveMeta): BlogBlockType[] {
  const seen = new Set<string>();
  const out: BlogBlockType[] = [];
  const groups = meta.manifest?.blocks ?? {};
  for (const group of Object.values(groups)) {
    for (const resolveType of Object.keys(group)) {
      if (!resolveType.startsWith(BLOG_BLOCK_PREFIX) || seen.has(resolveType)) {
        continue;
      }
      seen.add(resolveType);
      const md = resolveBlockSchemaMetadata(resolveType, meta);
      out.push({
        resolveType,
        title: md.title ?? blockComponentName(resolveType),
        description: md.description,
        icon: md.icon,
      });
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** "site/sections/Blog/Post/Paragraph.tsx" -> "Paragraph" */
export function blockComponentName(resolveType: string): string {
  const base = resolveType.split("/").pop() ?? resolveType;
  return base.replace(/\.(tsx?|jsx?)$/, "");
}
