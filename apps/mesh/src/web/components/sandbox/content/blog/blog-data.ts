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

// Shared, frozen empty payload so an absent block/payload yields a
// referentially-stable value across renders — `useAutosave` compares `initial`
// by reference to detect external changes, so a fresh `{}` each render would
// loop. Frozen because consumers only ever spread/clone it, never mutate.
const EMPTY_PAYLOAD: Record<string, unknown> = Object.freeze({});

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

/**
 * On-disk block filename. Deco encodes the block id, so slashes become
 * `%2F`. `encodeURIComponent` reproduces deco's exact scheme (verified
 * against existing `collections%2Fblog%2F…` files).
 */
export function blogBlockFilePath(key: string): string {
  return `.deco/blocks/${encodeURIComponent(key)}.json`;
}

// ------------------ Post relations (authors/categories picker) ------------------

export interface RelationPickerState {
  /** One option per record, plus one per unresolvable selected ref. */
  options: Array<{ value: string; label: string }>;
  /** The current selection expressed as option values. */
  selectedValues: string[];
  /** Map the picker's next values back to the denormalized refs to store. */
  refsForValues: (values: string[]) => unknown[];
}

/**
 * State for the multi-select that links a post to Author/Category records.
 *
 * Options are keyed by the record's decofile key — the only identity that is
 * guaranteed present and unique. The denormalized refs stored on the post
 * (`{ name, email }` / `{ name, slug }`, or plain strings) resolve back to a
 * record by the identity field when present, falling back to the name —
 * authors created in the UI start with an empty email, and without the
 * fallback their selection would never display. Refs that resolve to no
 * record at all (record deleted, identity renamed) become synthetic options,
 * so they stay visible and unselectable instead of being silently dropped by
 * the next change.
 */
export function relationPickerState({
  records,
  selected,
  valueField,
  toRef,
}: {
  records: Array<{ key: string; payload: Record<string, unknown> }>;
  selected: unknown;
  /** Identity field of the denormalized ref (authors: email, categories: slug). */
  valueField: string;
  /** Build the denormalized ref stored on the post for a picked record. */
  toRef: (payload: Record<string, unknown>) => Record<string, unknown>;
}): RelationPickerState {
  const refs = Array.isArray(selected) ? selected : [];
  const refValue = (ref: unknown): string =>
    typeof ref === "string" ? ref : str(asRecord(ref)?.[valueField]);
  const refName = (ref: unknown): string =>
    typeof ref === "string" ? ref : str(asRecord(ref)?.name);

  const recordFor = (ref: unknown) => {
    const value = refValue(ref);
    const byValue = value
      ? records.find(({ payload }) => str(payload[valueField]) === value)
      : undefined;
    if (byValue) return byValue;
    const name = refName(ref);
    return name
      ? records.find(({ payload }) => str(payload.name) === name)
      : undefined;
  };

  const options = records.map(({ key, payload }) => ({
    value: key,
    label: str(payload.name) || str(payload[valueField]) || key,
  }));

  const unresolved = new Map<string, unknown>();
  const selectedValues: string[] = [];
  refs.forEach((ref, index) => {
    const match = recordFor(ref);
    if (match) {
      if (!selectedValues.includes(match.key)) selectedValues.push(match.key);
      return;
    }
    const value = `unresolved:${index}`;
    unresolved.set(value, ref);
    selectedValues.push(value);
    options.push({ value, label: refName(ref) || refValue(ref) || "Unknown" });
  });

  const refsForValues = (values: string[]): unknown[] =>
    values
      .map((value) => {
        const record = records.find((r) => r.key === value);
        return record ? toRef(record.payload) : unresolved.get(value);
      })
      .filter((ref) => ref !== undefined);

  return { options, selectedValues, refsForValues };
}

// ------------------ Post metadata + category mutation ------------------

/** A single category reference, denormalized on a post payload. */
export interface CategoryRef {
  name: string;
  slug: string;
}

/** Compact metadata for a post, used by the posts list filters/sort. */
export interface PostMeta {
  /** Decofile key (block id). */
  key: string;
  title: string;
  slug: string;
  /** Raw `date` string from the payload (ISO date, possibly empty). */
  date: string;
  /** Slugs of the post's categories (denormalized). */
  categorySlugs: string[];
  /** Emails of the post's authors (denormalized). */
  authorEmails: string[];
  /** Required fields the post is missing (empty when valid). */
  missing: string[];
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * A category on a post can be a plain slug string or a `{ name, slug }`
 * object (deco denormalizes the latter). Tolerate both.
 */
function categorySlugOf(item: unknown): string {
  if (typeof item === "string") return item;
  const rec = asRecord(item);
  return rec ? str(rec.slug) : "";
}

/** Authors are denormalized as `{ name, email }`; tolerate plain strings. */
function authorEmailOf(item: unknown): string {
  if (typeof item === "string") return item;
  const rec = asRecord(item);
  return rec ? str(rec.email) : "";
}

/**
 * Which required fields a post payload is missing (empty ⇒ valid). A post with
 * no title/slug/excerpt or zero categories is incomplete — the list marks it
 * and the editor blocks preview.
 */
export function missingPostFields(payload: Record<string, unknown>): string[] {
  const missing: string[] = [];
  if (!str(payload.title).trim()) missing.push("Title");
  if (!str(payload.slug).trim()) missing.push("Slug");
  if (
    toArray(payload.categories).map(categorySlugOf).filter(Boolean).length === 0
  ) {
    missing.push("Category");
  }
  if (!str(payload.excerpt).trim()) missing.push("Excerpt");
  if (!str(payload.image).trim()) missing.push("Cover image");
  return missing;
}

/**
 * All posts paired with the metadata the posts list filters and sorts on.
 * Reads the denormalized `categories`/`authors` arrays, tolerating either
 * strings or `{slug}`/`{email}` objects.
 */
export function listPostsWithMeta(
  decofile: Record<string, unknown>,
): PostMeta[] {
  return listBlogPayloads(decofile, "posts").map(({ key, payload }) => ({
    key,
    title: str(payload.title) || "Untitled post",
    slug: str(payload.slug),
    date: str(payload.date),
    categorySlugs: toArray(payload.categories)
      .map(categorySlugOf)
      .filter(Boolean),
    authorEmails: toArray(payload.authors).map(authorEmailOf).filter(Boolean),
    missing: missingPostFields(payload),
  }));
}

/**
 * Append a category to a post payload, keyed by slug. Idempotent — a slug
 * already present yields an equivalent payload (no duplicate). Pure: returns
 * a new payload, never mutates the input.
 */
export function addCategoryToPost(
  payload: Record<string, unknown>,
  category: CategoryRef,
): Record<string, unknown> {
  const categories = toArray(payload.categories);
  if (categories.some((c) => categorySlugOf(c) === category.slug)) {
    return payload;
  }
  return {
    ...payload,
    categories: [...categories, { name: category.name, slug: category.slug }],
  };
}

/**
 * Replace a post's categories with exactly the given one. Pure: returns a new
 * payload, never mutates the input. Used by the bulk "replace" mode to migrate
 * posts to a single category in one step.
 */
export function replaceCategoryOnPost(
  payload: Record<string, unknown>,
  category: CategoryRef,
): Record<string, unknown> {
  const current = toArray(payload.categories);
  if (current.length === 1 && categorySlugOf(current[0]) === category.slug) {
    return payload;
  }
  return {
    ...payload,
    categories: [{ name: category.name, slug: category.slug }],
  };
}

/**
 * Rewrite a post's reference to `oldSlug` so it points at `category` (its new
 * slug + name), preserving the post's other categories and their order. If the
 * post already carried the new slug too, the duplicate is collapsed. Pure:
 * returns the SAME object when the post doesn't reference `oldSlug`, so callers
 * skip no-ops by identity. Used by the category slug-rename cascade.
 */
export function renameCategoryOnPost(
  payload: Record<string, unknown>,
  oldSlug: string,
  category: CategoryRef,
): Record<string, unknown> {
  const categories = toArray(payload.categories);
  if (!categories.some((c) => categorySlugOf(c) === oldSlug)) {
    return payload;
  }
  // Rewrite BOTH the old slug and any pre-existing new-slug entry to the fresh
  // `{ name, slug }`. Refreshing the pre-existing one matters when it sits
  // before the old slug: the dedupe below keeps the first occurrence, so
  // without this the stale denormalized name would win over the rename.
  const mapped = categories.map((c) => {
    const slug = categorySlugOf(c);
    return slug === oldSlug || slug === category.slug
      ? { name: category.name, slug: category.slug }
      : c;
  });
  // A post that listed both the old and the new slug would now name the new
  // slug twice — keep the first occurrence. Only dedupe real slugs so we never
  // silently drop malformed (slug-less) entries.
  const seen = new Set<string>();
  const deduped = mapped.filter((c) => {
    const slug = categorySlugOf(c);
    if (!slug) return true;
    if (seen.has(slug)) return false;
    seen.add(slug);
    return true;
  });
  return { ...payload, categories: deduped };
}

/**
 * Drop every reference to `slug` from a post. Pure: returns the SAME object
 * when the post doesn't reference `slug`. Used by the category delete cascade.
 */
export function removeCategoryFromPost(
  payload: Record<string, unknown>,
  slug: string,
): Record<string, unknown> {
  const categories = toArray(payload.categories);
  if (!categories.some((c) => categorySlugOf(c) === slug)) {
    return payload;
  }
  return {
    ...payload,
    categories: categories.filter((c) => categorySlugOf(c) !== slug),
  };
}

/**
 * Stamp a post payload as modified now (full ISO date-time). Apply on every
 * write that changes an existing post — editor autosave, category cascades,
 * bulk updates — but NOT on create/duplicate, where `dateModified` would just
 * echo the creation date. Pure: returns a new payload.
 */
export function stampPostModified(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return { ...payload, dateModified: new Date().toISOString() };
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
        type: "Person",
        email: "",
        jobTitle: "",
        company: "",
        avatar: "",
      };
    case "categories":
      return {
        name: "New category",
        slug: `category-${randomHex(8)}`,
        description: "",
        sections: [],
      };
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unhandled blog kind: ${String(_exhaustive)}`);
    }
  }
}

export type BlogBlockSource = "app" | "site";

export interface BlogBlockType {
  resolveType: string;
  title: string;
  description?: string;
  /** @untitledui/icons component name; resolved via getIconComponent. */
  iconName: string;
  /** URL when the section declares `@icon` as an image (http(s)/data/absolute). */
  iconUrl?: string;
  /** "app" = deco-cms/blog built-ins; "site" = section defined by this site. */
  source: BlogBlockSource;
}

/**
 * Defaults for the well-known blog block component names. Used to give
 * the inserter pretty labels, descriptions and icons.
 *
 * For **app blocks** (`blog/sections/blocks/*`) the catalog overrides the
 * schema metadata — built-in schemas typically just echo the class name
 * (e.g. "BlockImage"), and we want the friendly label ("Image") instead.
 *
 * For **site blocks** (`site/sections/Blog/Post/*`) the schema's `@title`
 * / `@description` / `@icon` win — site authors should be in control of
 * their own block presentation. The catalog only fills in when the schema
 * omits a field.
 */
const KNOWN_BLOG_BLOCK_CATALOG: Record<
  string,
  { title: string; description: string; iconName: string }
> = {
  Paragraph: {
    title: "Paragraph",
    description: "Rich text content",
    iconName: "Pilcrow01",
  },
  Heading: {
    title: "Heading",
    description: "Section title (H1–H6)",
    iconName: "HeadingSquare",
  },
  Quote: {
    title: "Quote",
    description: "Pull quote",
    iconName: "MessageTextSquare02",
  },
  Code: {
    title: "Code",
    description: "Code block with syntax highlighting",
    iconName: "Code02",
  },
  List: {
    title: "List",
    description: "Bulleted or numbered list",
    iconName: "List",
  },
  BlockImage: {
    title: "Image",
    description: "Image with optional caption",
    iconName: "Image01",
  },
  Video: {
    title: "Video",
    description: "Embedded video",
    iconName: "PlayCircle",
  },
  Divider: {
    title: "Divider",
    description: "Horizontal divider",
    iconName: "Divider",
  },
  Cta: {
    title: "Call to action",
    description: "Button linking to a URL",
    iconName: "CursorClick01",
  },
  Callout: {
    title: "Callout",
    description: "Highlighted note, tip or warning",
    iconName: "Lightbulb02",
  },
  Stat: {
    title: "Stat",
    description: "Single key metric",
    iconName: "BarChartSquareUp",
  },
  StatGroup: {
    title: "Stat group",
    description: "Row of metrics",
    iconName: "BarChartSquare02",
  },
  CardGroup: {
    title: "Card group",
    description: "Grid of cards",
    iconName: "LayoutGrid01",
  },
  Checklist: {
    title: "Checklist",
    description: "List of check items",
    iconName: "CheckSquare",
  },
  Steps: {
    title: "Steps",
    description: "Step-by-step guide",
    iconName: "LayersThree01",
  },
  Comparison: {
    title: "Comparison",
    description: "Side-by-side comparison",
    iconName: "Columns03",
  },
  Table: {
    title: "Table",
    description: "Rows and columns of structured data",
    iconName: "Table",
  },
  ProductCard: {
    title: "Product card",
    description: "Single product",
    iconName: "Tag01",
  },
  ProductShelf: {
    title: "Product shelf",
    description: "Row of products",
    iconName: "ShoppingBag01",
  },
};

const FALLBACK_BLOG_BLOCK_ICON = "Box";

function blogBlockSource(resolveType: string): BlogBlockSource {
  return resolveType.startsWith("site/") ? "site" : "app";
}

/**
 * Schema `icon` strings can be either an @untitledui/icons component name
 * (e.g. "Pilcrow01") or an image URL declared via `@icon`. URLs start
 * with a protocol, `data:`, or an absolute path.
 */
function isImageUrl(icon: string): boolean {
  return (
    icon.startsWith("http://") ||
    icon.startsWith("https://") ||
    icon.startsWith("data:") ||
    icon.startsWith("/")
  );
}

/**
 * Pick the first defined value among the candidates. Used to express
 * precedence chains compactly without `??` ladders that obscure intent.
 */
function pick<T>(...candidates: Array<T | undefined>): T | undefined {
  for (const c of candidates) {
    if (c !== undefined) return c;
  }
  return undefined;
}

/**
 * Discover the content block types a post can contain from the live
 * manifest, with title/icon metadata for the inserter UI. Recognizes both
 * the `deco-cms/blog` app blocks (`blog/sections/blocks/*`) and
 * site-defined blog blocks (`site/sections/Blog/Post/*`), matching the
 * same set that `isBlogPostBlockResolveType` accepts everywhere else.
 *
 * Precedence depends on the block's source — see KNOWN_BLOG_BLOCK_CATALOG.
 */
export function discoverBlogBlockTypes(meta: LiveMeta): BlogBlockType[] {
  const seen = new Set<string>();
  const out: BlogBlockType[] = [];
  const groups = meta.manifest?.blocks ?? {};
  for (const group of Object.values(groups)) {
    for (const resolveType of Object.keys(group)) {
      if (!isBlogPostBlockResolveType(resolveType) || seen.has(resolveType)) {
        continue;
      }
      seen.add(resolveType);
      const md = resolveBlockSchemaMetadata(resolveType, meta);
      const name = blockComponentName(resolveType);
      const catalog = KNOWN_BLOG_BLOCK_CATALOG[name];
      const source = blogBlockSource(resolveType);

      // Site blocks: schema's @title/@description/@icon wins. App blocks:
      // catalog wins (built-in schemas just echo class names like "BlockImage").
      const title =
        (source === "site"
          ? pick(md.title, catalog?.title)
          : pick(catalog?.title, md.title)) ?? name;
      const description =
        source === "site"
          ? pick(md.description, catalog?.description)
          : pick(catalog?.description, md.description);

      // `@icon` on a site block can be a URL (rendered as <img>) or an
      // @untitledui/icons component name. App blocks always use the
      // catalog icon — built-in schemas don't carry useful icon hints.
      const rawIcon = source === "site" ? md.icon : undefined;
      const iconUrl = rawIcon && isImageUrl(rawIcon) ? rawIcon : undefined;
      const iconName =
        iconUrl !== undefined
          ? (catalog?.iconName ?? FALLBACK_BLOG_BLOCK_ICON)
          : (pick(rawIcon, catalog?.iconName) ?? FALLBACK_BLOG_BLOCK_ICON);

      out.push({
        resolveType,
        title,
        description,
        iconName,
        iconUrl,
        source,
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

const BLOG_POST_BLOCK_PREFIXES = [
  "blog/sections/blocks/",
  "site/sections/Blog/Post/",
] as const;

/** True when resolveType points at a blog post content block editor. */
export function isBlogPostBlockResolveType(resolveType: string): boolean {
  return BLOG_POST_BLOCK_PREFIXES.some((prefix) =>
    resolveType.startsWith(prefix),
  );
}
