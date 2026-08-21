/**
 * Pure helpers for the Blog content collections (Posts, Authors,
 * Categories). Deco's blog app stores each record as a decofile block
 * keyed `collections/blog/<kind>/<id>` whose `__resolveType` points at the
 * matching loader. We detect by `__resolveType` (robust to however the
 * decofile keys the entry) and edit the wrapper object in place.
 *
 * On-disk, block files are URL-encoded: the block id
 * `collections/blog/posts/abc` lives at
 * `.deco/blocks/collections%2Fblog%2Fposts%2Fabc.json`. Writes go through the
 * shared `useSaveBlock`/`useDeleteBlock`, whose `decoBlockFilePath` already
 * reproduces that encoding.
 */
import type { StudioToolIO } from "@decocms/shared/tools/tool-io";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { resolveBlockSchemaMetadata } from "@/components/sections-editor/resolve-schema";

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
  /**
   * Raw `scheduledDatetime` from the payload — the instant the post goes live,
   * empty when the post isn't scheduled. Distinct from `date`, which is the
   * editorial date the site displays. Only newer versions of the deco blog app
   * write it, so it is empty on every post until then.
   */
  scheduledDatetime: string;
  /** Slugs of the post's categories (denormalized). */
  categorySlugs: string[];
  /** Emails of the post's authors (denormalized). */
  authorEmails: string[];
  /** Required fields the post is missing (empty when valid). */
  missing: string[];
  /** Publication state — see `postStatus`. */
  status: PostStatus;
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

/** The three publication states the CMS edits. */
export type PostStatus = "draft" | "scheduled" | "published";

/** Local hour of day a newly scheduled post goes live. */
export const DEFAULT_SCHEDULE_HOUR = 8;

/** Publication state from `status` alone — unset means published, so adding the field unpublished nothing. */
export function postStatus(payload: Record<string, unknown>): PostStatus {
  const status = str(payload.status);
  if (status === "" || status === "published") return "published";
  if (status === "scheduled") return "scheduled";
  return "draft";
}

/** Whether missing required fields bar this post from *becoming* published — the only gated move. */
export function blocksPostStatus(
  payload: Record<string, unknown>,
  next: PostStatus,
): boolean {
  if (next !== "published" || postStatus(payload) === "published") return false;
  return missingPostFields(payload).length > 0;
}

/** Go-live instant offered when none is set: tomorrow, local, at {@link DEFAULT_SCHEDULE_HOUR}. */
export function defaultScheduledDatetime(now: Date): string {
  const day = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    DEFAULT_SCHEDULE_HOUR,
  );
  return day.toISOString();
}

/** Move a post to `next`: leaving `scheduled` clears the stale instant, entering it seeds one. */
export function setPostStatus(
  payload: Record<string, unknown>,
  next: PostStatus,
  now: Date,
): Record<string, unknown> {
  if (next !== "scheduled") {
    return { ...payload, status: next, scheduledDatetime: "" };
  }
  const existing = str(payload.scheduledDatetime);
  return {
    ...payload,
    status: "scheduled",
    scheduledDatetime: Number.isNaN(new Date(existing).getTime())
      ? defaultScheduledDatetime(now)
      : existing,
  };
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
    scheduledDatetime: str(payload.scheduledDatetime),
    categorySlugs: toArray(payload.categories)
      .map(categorySlugOf)
      .filter(Boolean),
    authorEmails: toArray(payload.authors).map(authorEmailOf).filter(Boolean),
    missing: missingPostFields(payload),
    status: postStatus(payload),
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
        alt: "",
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

// ------------------ Brand rules (dos / guardrails / values / competitors) ----

/** Where the editorial brand context lives, as Spire named it. */
export const BRAND_BLOCK_KEY = "blog-manager-brand";

/**
 * One editorial rule: a short name plus a markdown body. Replaces the flat
 * strings these fields used to hold — a rule worth writing down needs more
 * room than a single-line input, and a competitor is useless without the
 * context of why it matters.
 */
export interface BrandRule {
  name: string;
  value: string;
}

/**
 * Read a rule list from a brand block, tolerating the flat `string[]` shape
 * that Spire wrote and that this editor saved before the change. A legacy
 * string becomes the rule's name with an empty body, so nothing is lost and the
 * block picks up the new shape on the next save — no migration.
 *
 * An object entry survives even when both its fields are empty: that is a row
 * the user just added and hasn't typed into yet, and dropping it made the
 * editor's "add" button do nothing. Only a non-object, or a legacy string that
 * is blank, is junk. Use {@link filledBrandRules} where substance is what
 * matters.
 */
export function normalizeBrandRules(value: unknown): BrandRule[] {
  if (!Array.isArray(value)) return [];
  const rules: BrandRule[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      if (entry.trim()) rules.push({ name: entry, value: "" });
      continue;
    }
    const record = asRecord(entry);
    if (!record) continue;
    rules.push({ name: str(record.name), value: str(record.value) });
  }
  return rules;
}

/**
 * Rules a reader would consider written. Blank rows are real editor state, so
 * they belong on screen — but not in a prompt, and not in the "is this field
 * still empty?" check that decides whether an extract may fill it.
 */
export function filledBrandRules(rules: BrandRule[]): BrandRule[] {
  return rules.filter((rule) => rule.name.trim() || rule.value.trim());
}

// ------------------ Brand-evidence sampling (tone of voice) ------------------

/** Total serialized chars sent to the model; keeps one call affordable. */
const BRAND_EVIDENCE_MAX_CHARS = 60_000;
/**
 * Per-block cap. Deliberately small relative to the total: breadth beats depth
 * here. Voice repeats across a site, so 15 pages read shallowly characterize it
 * better than 5 read deeply — and a high cap lets the few biggest pages (which
 * are big from having many sections, not from having more voice) crowd out the
 * institutional ones that carry the values.
 */
const BRAND_EVIDENCE_MAX_BLOCK_CHARS = 4_000;

export interface BrandEvidenceBlock {
  key: string;
  content: string;
}

/**
 * Pull the human-written phrases out of a block as `prop: phrase` lines.
 *
 * Sending the block's JSON does not work: a real page is mostly asset URLs,
 * resolveTypes and loader config, so serialized size measures how many sections
 * a page has, not how much voice it carries. Ranking Farm Rio's 1018 pages by
 * JSON size surfaced product-listing stubs and buried the institutional pages
 * that hold the brand's values.
 *
 * A phrase is a string containing a space — enough to separate "do rio pro
 * mundo" and "92% de funcionárias" from "site/sections/Layout/Flex.tsx" and
 * "20px" without a prop allowlist. Prop names are kept because they say what
 * kind of copy it is, and exact duplicates are dropped: a site repeats the same
 * banner text across hundreds of pages, and paying for it once is enough.
 * Near-duplicates that differ only in casing survive on purpose — that
 * inconsistency is itself a fact about the brand.
 */
export function extractBlockProse(block: unknown): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  const walk = (node: unknown, prop: string) => {
    if (typeof node === "string") {
      if (!node.includes(" ") || node.length < 4) return;
      if (/^(https?:)?\/\//.test(node) || /^data:/.test(node)) return;
      const line = `${prop}: ${node.trim()}`;
      if (seen.has(line)) return;
      seen.add(line);
      lines.push(line);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, prop);
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "__resolveType") continue;
        walk(value, key);
      }
    }
  };

  walk(block, "block");
  return lines.join("\n");
}

/**
 * The blocks that show how this brand writes, most telling first: existing
 * posts (the brand writing blogposts), then categories (the topics it owns),
 * then pages (marketing copy — weaker voice evidence, and all a site with no
 * blog has; Farm Rio has 1018 pages and zero posts).
 *
 * Within each tier, most prose first — a product-listing page serializes to
 * almost nothing once URLs are dropped, an institutional page to paragraphs.
 *
 * `pageKeys` comes from the caller's `extractPages`, keeping this independent
 * of the page-list module.
 */
export function selectBrandEvidenceBlocks(
  decofile: Record<string, unknown>,
  pageKeys: string[],
): BrandEvidenceBlock[] {
  const prose = new Map<string, string>();
  const proseFor = (key: string) => {
    const cached = prose.get(key);
    if (cached !== undefined) return cached;
    const extracted = extractBlockProse(decofile[key]).slice(
      0,
      BRAND_EVIDENCE_MAX_BLOCK_CHARS,
    );
    prose.set(key, extracted);
    return extracted;
  };
  const byProseDesc = (a: string, b: string) =>
    proseFor(b).length - proseFor(a).length;

  const ordered = [
    ...listBlogPayloads(decofile, "posts")
      .map((p) => p.key)
      .sort(byProseDesc),
    ...listBlogPayloads(decofile, "categories").map((c) => c.key),
    ...[...pageKeys].sort(byProseDesc),
  ];

  const selected: BrandEvidenceBlock[] = [];
  const seen = new Set<string>();
  let remaining = BRAND_EVIDENCE_MAX_CHARS;

  for (const key of ordered) {
    if (seen.has(key)) continue;
    if (!decofile[key]) continue;
    seen.add(key);
    const content = proseFor(key);
    if (content.length > remaining) break;
    selected.push({ key, content });
    remaining -= content.length;
  }

  return selected;
}

// ------------------ Themes (the editorial planning queue) --------------------

/**
 * Themes live one per block under this prefix, and carry no `__resolveType` —
 * they are planning state for Studio, so the site must never resolve them. One
 * block each (rather than an array in one block) keeps a write surgical: a
 * suggestion appending five themes cannot clobber the one being edited.
 */
export const THEME_KEY_PREFIX = "blog-manager/themes/";

/** A theme: a title and a markdown brief. `key` is its block key. */
export interface ThemeEntry {
  key: string;
  title: string;
  body: string;
  createdAt: string;
}

export function newThemeKey(): string {
  return `${THEME_KEY_PREFIX}${crypto.randomUUID()}`;
}

/** Newest first, so a fresh suggestion lands at the top of the list. */
export function scanThemes(decofile: Record<string, unknown>): ThemeEntry[] {
  const themes: ThemeEntry[] = [];
  for (const [key, value] of Object.entries(decofile)) {
    if (!key.startsWith(THEME_KEY_PREFIX)) continue;
    const record = asRecord(value);
    if (!record) continue;
    themes.push({
      key,
      title: str(record.title),
      body: str(record.body),
      createdAt: str(record.createdAt),
    });
  }
  return themes.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || a.title.localeCompare(b.title),
  );
}

// ------------------ Formats (loose post templates) ---------------------------

/**
 * A format is a name plus a markdown brief, injected into the generation
 * prompt — deliberately loose, so it cites sections rather than sequencing
 * them. Same `{ name, value }` shape as a brand rule, so `normalizeBrandRules`
 * already reads the list.
 */
export const FORMATS_BLOCK_KEY = "blog-manager-formats";

/** How many posts the format suggestion reads. */
const MAX_POST_STRUCTURES = 40;

export interface PostStructure {
  key: string;
  title: string;
  /** Component names of the post's sections, in document order. */
  sections: string[];
}

/**
 * The shape of each existing post: which sections it uses, in order.
 *
 * This — not the prose — is what reveals the formats a blog already writes in.
 * Forty sequences of component names is a tiny input next to forty post bodies,
 * and it is the only part that answers "how is this post built".
 */
export function postStructures(
  decofile: Record<string, unknown>,
): PostStructure[] {
  return listBlogPayloads(decofile, "posts")
    .slice(0, MAX_POST_STRUCTURES)
    .map(({ key, payload }) => ({
      key,
      title: str(payload.title),
      sections: toArray(payload.sections)
        .map((section) => str(asRecord(section)?.__resolveType))
        .filter(Boolean)
        .map(blockComponentName),
    }));
}

export interface MentionableSection {
  /** The token a brief cites, and what gets inserted: `ProductShelf`. */
  name: string;
  title: string;
  description?: string;
}

/**
 * The sections a format's brief may cite, deduped by component name.
 *
 * `discoverBlogBlockTypes` dedupes by `resolveType`, so an app and a site
 * variant of the same component both survive — and since a citation is the bare
 * component name, those two are indistinguishable once written. Collapsing them
 * here keeps the picker from listing the same `@Name` twice.
 */
export function mentionableSections(meta: LiveMeta): MentionableSection[] {
  const byName = new Map<string, MentionableSection>();
  for (const block of discoverBlogBlockTypes(meta)) {
    const name = blockComponentName(block.resolveType);
    if (byName.has(name)) continue;
    byName.set(name, {
      name,
      title: block.title,
      description: block.description,
    });
  }
  return [...byName.values()];
}

/**
 * `@Name` mentions in a format's brief. Requires a word boundary before the
 * `@` so an email address in the prose isn't read as a citation, matching when
 * the editor's picker fires.
 */
export function citedSections(markdown: string): string[] {
  const cited = new Set<string>();
  for (const match of markdown.matchAll(/(?:^|[\s([{>])@([A-Za-z][\w-]*)/g)) {
    if (match[1]) cited.add(match[1]);
  }
  return [...cited];
}

/**
 * Cited sections the site no longer has. Without surfacing these, a format
 * keeps pointing at a renamed section and only the generated post shows it.
 */
export function unknownCitations(
  markdown: string,
  available: string[],
): string[] {
  const known = new Set(available);
  return citedSections(markdown).filter((name) => !known.has(name));
}

/**
 * Sections for the starter format, in a sensible reading order, skipping
 * whatever this site doesn't have — so the brief never cites something
 * unrenderable. Its prose comes from the caller, to stay translated.
 */
const DEFAULT_FORMAT_SECTIONS = [
  "Heading",
  "Paragraph",
  "BlockImage",
  "List",
  "Cta",
] as const;

export function defaultFormatSections(available: string[]): string[] {
  const known = new Set(available);
  return DEFAULT_FORMAT_SECTIONS.filter((name) => known.has(name));
}

/** Casing, accents and spacing are presentation, not identity. */
export function normalizeTitleKey(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Drop suggestions whose title already exists, and duplicates within the batch.
 * The tool is told not to repeat, but it is a model — and running "suggest"
 * twice is the normal way to use the button, so the second run must not double
 * the list.
 */
export function dedupeSuggestedThemes<T extends { title: string }>(
  existingTitles: string[],
  suggested: T[],
): T[] {
  const seen = new Set(existingTitles.map(normalizeTitleKey));
  const fresh: T[] = [];
  for (const theme of suggested) {
    const key = normalizeTitleKey(theme.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fresh.push(theme);
  }
  return fresh;
}

// ------------------ Generation ----------------------------------------------

/** Brand fields a generated post cannot be written without. */
export type BrandRequirement =
  | "companyName"
  | "language"
  | "description"
  | "tone"
  | "targetAudience"
  | "dos"
  | "avoid";

const REQUIRED_BRAND_TEXT = [
  "companyName",
  "language",
  "description",
  "tone",
  "targetAudience",
] as const satisfies readonly BrandRequirement[];

/**
 * What the brand block still lacks before anything may be generated.
 *
 * These are the three tabs that decide how a post reads — the basics, the
 * generation instructions and the guardrails. Without them the model falls back
 * on what a brand in this category usually sounds like, which is the one
 * outcome the whole feature exists to avoid, so this blocks rather than warns.
 * `values`, `categories` and `competitors` are genuinely extra.
 */
export function missingBrandForGeneration(block: unknown): BrandRequirement[] {
  const brand = asRecord(block) ?? {};
  const missing: BrandRequirement[] = [];
  for (const field of REQUIRED_BRAND_TEXT) {
    if (!str(brand[field]).trim()) missing.push(field);
  }
  if (filledBrandRules(normalizeBrandRules(brand.dos)).length === 0) {
    missing.push("dos");
  }
  if (filledBrandRules(normalizeBrandRules(brand.avoid)).length === 0) {
    missing.push("avoid");
  }
  return missing;
}

/**
 * Component name → the resolveType this site actually exposes for it.
 *
 * A generated section names its kind (`Heading`); only the site knows whether
 * that is `blog/sections/blocks/Heading.tsx` or its own
 * `site/sections/Blog/Post/Heading.tsx`. Keeping the mapping here means the
 * model never sees a resolveType and so can never invent one.
 */
export function sectionResolveTypes(meta: LiveMeta): Record<string, string> {
  const byName: Record<string, string> = {};
  for (const block of discoverBlogBlockTypes(meta)) {
    const name = blockComponentName(block.resolveType);
    if (!(name in byName)) byName[name] = block.resolveType;
  }
  return byName;
}

type DraftSection =
  StudioToolIO["BLOG_POST_DRAFT"]["output"]["sections"][number];

/**
 * Turn generated sections into decofile blocks.
 *
 * This is where the storage conventions live, and they differ per kind — a
 * `List` stores its items as one newline-joined string, while `Checklist` and
 * friends store JSON. Getting it wrong yields a block that saves fine and
 * renders empty, so each kind is written out explicitly rather than spread.
 *
 * A kind this site doesn't expose is dropped: better a shorter post than a
 * block the editor can't render.
 */
export function buildPostSections(
  sections: DraftSection[],
  resolveTypes: Record<string, string>,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const section of sections) {
    const __resolveType = resolveTypes[section.type];
    if (!__resolveType) continue;
    switch (section.type) {
      case "Heading":
        blocks.push({
          __resolveType,
          text: str(section.text),
          level: section.level ?? "2",
        });
        break;
      case "Paragraph":
        blocks.push({ __resolveType, html: str(section.html) });
        break;
      case "List":
        blocks.push({
          __resolveType,
          // One string, newline-separated — see ListBlock in plain-blocks.
          items: (section.items ?? []).join("\n"),
          style: section.style ?? "unordered",
        });
        break;
      case "Quote":
        blocks.push({ __resolveType, quote: str(section.quote) });
        break;
      case "Callout":
        blocks.push({
          __resolveType,
          title: str(section.title),
          body: str(section.body),
          variant: section.variant ?? "info",
        });
        break;
      case "Cta":
        blocks.push({
          __resolveType,
          text: str(section.text),
          href: str(section.href),
        });
        break;
      case "Divider":
        blocks.push({ __resolveType });
        break;
    }
  }
  return blocks;
}

/** URL-safe slug from a title: accents folded, punctuation dropped. */
export function slugifyTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** `slugifyTitle`, suffixed until it stops colliding with an existing post. */
export function uniquePostSlug(title: string, taken: string[]): string {
  const base = slugifyTitle(title) || `post-${randomHex(6)}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${randomHex(4)}`;
}

/**
 * The post payload for a generated draft, always scheduled.
 *
 * Generated posts are never published on save: a human reviews them, and the
 * schedule is the promise they opt into. `setPostStatus` keeps a valid
 * `scheduledDatetime`, so seeding it first is what pins the chosen instant.
 *
 * `image` is left empty — nothing here generates one, and a fabricated URL
 * would render a broken post. `missingPostFields` reports it, which is the
 * honest signal for the reviewer.
 */
export function buildGeneratedPostPayload({
  draft,
  resolveTypes,
  categories,
  scheduledFor,
  takenSlugs,
  now,
}: {
  draft: StudioToolIO["BLOG_POST_DRAFT"]["output"];
  resolveTypes: Record<string, string>;
  /** The site's categories, to resolve the chosen slugs into stored refs. */
  categories: CategoryRef[];
  scheduledFor: Date;
  takenSlugs: string[];
  now: Date;
}): Record<string, unknown> {
  const chosen = new Set(draft.categorySlugs);
  const payload: Record<string, unknown> = {
    title: draft.title,
    slug: uniquePostSlug(draft.title, takenSlugs),
    date: scheduledFor.toISOString().slice(0, 10),
    excerpt: draft.excerpt,
    image: "",
    alt: "",
    authors: [],
    categories: categories.filter((category) => chosen.has(category.slug)),
    seo: {
      title: draft.seo.title,
      description: draft.seo.description,
      image: "",
    },
    sections: buildPostSections(draft.sections, resolveTypes),
    scheduledDatetime: scheduledFor.toISOString(),
  };
  return setPostStatus(payload, "scheduled", now);
}
