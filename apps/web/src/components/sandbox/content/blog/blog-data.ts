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
import { sanitizeSiteUrl } from "@decocms/shared/deco-site-production-url";
import {
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TARGET_KINDS,
  CAMPAIGN_TRIGGERS,
  MAX_CAMPAIGN_PRODUCT_IMAGES,
  type CampaignObjective,
  type CampaignStatus,
  type CampaignTargetKind,
  type CampaignTrigger,
} from "@decocms/shared/blog-campaign";
import type { StudioToolIO } from "@decocms/shared/tools/tool-io";
import { BRAND_EVIDENCE_MAX_BLOCKS } from "@decocms/shared/blog-brand-evidence";
import type { TFunction, TranslationKey } from "@/i18n/use-t.ts";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { resolveBlockSchemaMetadata } from "@/components/sections-editor/resolve-schema";
import type { PageEntry } from "@/components/sections-editor/page-list";
import {
  type PageRole,
  pageRole,
  type SeoEvidenceEntry,
  selectSeoEvidence,
} from "./seo-evidence";

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

/**
 * An author denormalized on a post payload. The post carries the author's
 * FULL record — the blog app renders the author box (type, job title,
 * company, website, avatar) from the post, never from the Author block — so
 * extra fields ride along; `name`/`email` are only the identity.
 */
export interface AuthorRef {
  name: string;
  email: string;
  [field: string]: unknown;
}

/**
 * The site's authors as the refs a post stores — full record, identity
 * stringified. Authors without an email are dropped: nothing could reference
 * them.
 */
export function listAuthorRefs(decofile: Record<string, unknown>): AuthorRef[] {
  return listBlogPayloads(decofile, "authors")
    .map(({ payload }) => ({
      ...payload,
      name: str(payload.name),
      email: str(payload.email),
    }))
    .filter((author) => author.email);
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
  missing: MissingFieldKey[];
  /** Another post carries this same title — a warning, never a block. */
  duplicateTitle?: boolean;
  /** Publication state — see `postStatus`. */
  status: PostStatus;
  /** Which physical block backs this post — see {@link PostForm}. */
  form: PostForm;
}

/**
 * The two physical forms one lifecycle post takes. A `planning` post is a
 * block with no `__resolveType` under {@link PLANNING_POST_KEY_PREFIX}, so the
 * site never renders it (draft / generating / awaiting_review / archived). A
 * `live` post is the
 * classic `collections/blog/posts/<id>` block with a `__resolveType`
 * (scheduled / published). One stable `<id>` is shared across both forms; a
 * status change that crosses the boundary promotes/demotes the block — see
 * {@link movePostToStatus}.
 */
export type PostForm = "planning" | "live";

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
 * A required field a blog record can be missing. Identifies the field, never
 * names it: the name shown to the reader is a translation, resolved by
 * {@link missingFieldsLabel} at render time.
 */
export type MissingFieldKey =
  | "title"
  | "slug"
  | "category"
  | "excerpt"
  | "image"
  | "name";

const MISSING_FIELD_LABEL_KEYS: Record<MissingFieldKey, TranslationKey> = {
  title: "sandbox.blogField.title",
  slug: "sandbox.blogField.slug",
  category: "sandbox.blogField.category",
  excerpt: "sandbox.blogField.excerpt",
  image: "sandbox.blogField.image",
  name: "sandbox.blogField.name",
};

/** The missing fields as a reader-facing list ("Title, Excerpt"). */
export function missingFieldsLabel(
  missing: readonly MissingFieldKey[],
  t: TFunction,
): string {
  return missing.map((key) => t(MISSING_FIELD_LABEL_KEYS[key])).join(", ");
}

/**
 * Which required fields a post payload is missing (empty ⇒ valid). A post with
 * no title/slug/excerpt or zero categories is incomplete — the list marks it
 * and the editor blocks preview.
 */
export function missingPostFields(
  payload: Record<string, unknown>,
): MissingFieldKey[] {
  const missing: MissingFieldKey[] = [];
  if (!str(payload.title).trim()) missing.push("title");
  if (!str(payload.slug).trim()) missing.push("slug");
  if (
    toArray(payload.categories).map(categorySlugOf).filter(Boolean).length === 0
  ) {
    missing.push("category");
  }
  if (!str(payload.excerpt).trim()) missing.push("excerpt");
  if (!str(payload.image).trim()) missing.push("image");
  return missing;
}

/**
 * The lifecycle a post travels, in board order.
 *
 * These values are the blog app's own `PostStatus` union — Studio writes them
 * into `payload.status`, the app reads them, so the vocabulary has to be the
 * app's, not one invented here. Do not add a state the app cannot read.
 *
 * `draft` / `generating` / `awaiting_review` / `archived` are stored as
 * planning-only blocks the site never resolves (see
 * {@link PLANNING_POST_KEY_PREFIX}); `scheduled` / `published` are the live
 * states the site renders.
 */
export type PostStatus =
  | "draft"
  | "generating"
  | "awaiting_review"
  | "scheduled"
  | "published"
  | "archived";

/** The board lanes, left → right — the order the lifecycle advances. */
export const POST_STATUSES: readonly PostStatus[] = [
  "draft",
  "generating",
  "awaiting_review",
  "scheduled",
  "published",
  "archived",
];

/** Local hour of day a newly scheduled post goes live. */
export const DEFAULT_SCHEDULE_HOUR = 8;

/**
 * Publication state from `status` alone. Planning posts always carry an
 * explicit non-live state; on a live post an unset/blank status still means
 * published (legacy: adding the field unpublished nothing).
 *
 * `idea` and `in_review` are read as `draft` / `awaiting_review`: a short-lived
 * Studio-only vocabulary that predates aligning on the blog app's union.
 */
export function postStatus(payload: Record<string, unknown>): PostStatus {
  switch (str(payload.status)) {
    case "draft":
    // Legacy Studio-only name for the first lane.
    case "idea":
      return "draft";
    case "generating":
      return "generating";
    case "awaiting_review":
    // Legacy Studio-only name for the review lane.
    case "in_review":
      return "awaiting_review";
    case "scheduled":
      return "scheduled";
    case "published":
      return "published";
    case "archived":
      return "archived";
    // Legacy: an unset status field means published (adding it unpublishes nothing).
    case "":
      return "published";
    // Any other value is unrecognized — the safest non-live state, not a live post.
    default:
      return "awaiting_review";
  }
}

/**
 * Whether this post may be deleted outright.
 *
 * Archived only. Every other status still resolves somewhere — a published
 * post is on the site, a scheduled one is about to be, and a draft is work
 * someone has not abandoned yet — so archiving is the one state where
 * dropping the block cannot break a live page. It also keeps a deliberate
 * step between "I'm done with this" and "it's gone".
 */
export function canDeletePost(payload: Record<string, unknown>): boolean {
  return postStatus(payload) === "archived";
}

/**
 * Whether missing required fields bar this post from *becoming* live — the
 * gated forward moves are Scheduled and Published. Pulling a post back to
 * review or an earlier planning state is never blocked.
 */
export function blocksPostStatus(
  payload: Record<string, unknown>,
  next: PostStatus,
): boolean {
  if (next !== "published" && next !== "scheduled") return false;
  if (postStatus(payload) === next) return false;
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
  /** Shared by `listAllPostsWithMeta` so the board scans the decofile once. */
  duplicates: Set<string> = duplicateTitleKeys(decofile),
): PostMeta[] {
  return listBlogPayloads(decofile, "posts").map(({ key, payload }) => ({
    key,
    duplicateTitle: duplicates.has(key),
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
    form: "live",
  }));
}

// ------------------ Lifecycle posts (idea → published) -----------------------

/**
 * Planning posts (draft / generating / awaiting_review / archived) live one
 * block each under this
 * prefix, carrying NO `__resolveType` — exactly like themes, so the site's blog
 * app never resolves an unfinished draft. Only when a post is scheduled is it
 * promoted to a real `collections/blog/posts/<id>` block the site renders.
 */
export const PLANNING_POST_KEY_PREFIX = "blog-manager/posts/";

/** True when a key points at a planning post — anything but scheduled/published. */
function isPlanningPostKey(key: string): boolean {
  return key.startsWith(PLANNING_POST_KEY_PREFIX);
}

/** The `<id>` shared by a post's planning and live forms — the last path segment. */
export function postIdOfKey(key: string): string {
  return key.split("/").pop() ?? key;
}

export function planningPostKey(id: string): string {
  return `${PLANNING_POST_KEY_PREFIX}${id}`;
}

export function livePostKey(id: string): string {
  return `collections/blog/posts/${id}`;
}

/** A fresh id for a new lifecycle post, unique enough for a per-site decofile. */
export function newPostId(): string {
  return randomHex(12);
}

/**
 * The planning brief a card carries before (and after) generation: the format
 * it should follow and the free-text angle. Stored under `payload.planning`;
 * consumed by generation and shown on the card.
 */
export interface PlanningMeta {
  /** The campaign this post was written for. */
  campaignKey?: string;
  format?: BrandRule;
  brief?: string;
}

/** Read the planning brief off a post payload, tolerating a missing/legacy shape. */
export function planningMeta(payload: Record<string, unknown>): PlanningMeta {
  const record = asRecord(payload.planning) ?? {};
  const format = asRecord(record.format);
  return {
    campaignKey: str(record.campaignKey) || undefined,
    format: format
      ? { name: str(format.name), value: str(format.value) }
      : undefined,
    brief: str(record.brief) || undefined,
  };
}

/** Payload for a post started by hand: a briefing, no body yet. */
export function emptyDraftPostPayload(args: {
  title: string;
  planning?: PlanningMeta;
  now: Date;
}): Record<string, unknown> {
  return {
    title: args.title,
    slug: "",
    excerpt: "",
    date: args.now.toISOString().slice(0, 10),
    image: "",
    alt: "",
    authors: [],
    categories: [],
    sections: [],
    status: "draft",
    planning: (args.planning ?? {}) as Record<string, unknown>,
  };
}

/** Rebuild a planning-post block (no `__resolveType`, so the site ignores it). */
export function buildPlanningPostBlock(
  key: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return { name: key, [WRAPPER_KEY.posts]: payload };
}

/**
 * Rebuild a post block in the form its key implies — planning (no
 * `__resolveType`) or live — so a content edit never accidentally promotes an
 * unpublished post to a site-rendered block. Crossing the boundary is a
 * status change, handled by {@link movePostToStatus}, not a content save.
 */
export function buildPostBlock(
  key: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return isPlanningPostKey(key)
    ? buildPlanningPostBlock(key, payload)
    : buildBlogBlock(key, "posts", payload);
}

/** All planning posts (everything but scheduled/published) with their payload. */
export function listPlanningPosts(
  decofile: Record<string, unknown>,
): Array<{ key: string; payload: Record<string, unknown> }> {
  const out: Array<{ key: string; payload: Record<string, unknown> }> = [];
  for (const [key, value] of Object.entries(decofile)) {
    if (!isPlanningPostKey(key)) continue;
    const block = asRecord(value);
    if (!block) continue;
    out.push({ key, payload: getBlogPayload(block, "posts") });
  }
  return out;
}

/**
 * Every post with its payload, both physical forms. A cascade that touches
 * what posts denormalize has to use this and not `listBlogPayloads`: a
 * planning draft carries no `__resolveType`, so matching on one skips the
 * whole board in silence. `buildPostBlock` writes each back in its own form.
 */
export function listAllPostPayloads(
  decofile: Record<string, unknown>,
): Array<{ key: string; payload: Record<string, unknown> }> {
  return [
    ...listPlanningPosts(decofile),
    ...listBlogPayloads(decofile, "posts"),
  ];
}

/**
 * Every post the board shows: planning posts first, then live posts. `form`
 * distinguishes them so the board can pick the right key on a lane move.
 */
export function listAllPostsWithMeta(
  decofile: Record<string, unknown>,
): PostMeta[] {
  const duplicates = duplicateTitleKeys(decofile);
  const planning: PostMeta[] = listPlanningPosts(decofile).map(
    ({ key, payload }) => ({
      key,
      duplicateTitle: duplicates.has(key),
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
      form: "planning",
    }),
  );
  return [...planning, ...listPostsWithMeta(decofile, duplicates)];
}

/** A promote/demote plan: blocks to write, keys to delete, applied atomically. */
export interface PostMove {
  writes: Record<string, unknown>;
  deletes: string[];
}

/**
 * Move a post to `next`, crossing the planning↔live boundary when the target
 * state requires it. draft/generating/awaiting_review/archived live as
 * planning blocks;
 * scheduled/published as live `collections/blog/posts/<id>` blocks. The `<id>`
 * and `slug` are preserved across a promote/demote, so links stay stable.
 *
 * Returns the write/delete set rather than performing it, so the caller can
 * apply it as one atomic `patchDecofile({ set, delete })`.
 */
export function movePostToStatus(
  entry: { key: string; payload: Record<string, unknown> },
  next: PostStatus,
  now: Date,
): PostMove {
  const nextPayload = setPostStatus(entry.payload, next, now);
  const id = postIdOfKey(entry.key);
  const targetForm: PostForm =
    next === "scheduled" || next === "published" ? "live" : "planning";
  const targetKey =
    targetForm === "live" ? livePostKey(id) : planningPostKey(id);
  const block =
    targetForm === "live"
      ? buildBlogBlock(targetKey, "posts", nextPayload)
      : buildPlanningPostBlock(targetKey, nextPayload);
  return {
    writes: { [targetKey]: block },
    deletes: targetKey === entry.key ? [] : [entry.key],
  };
}

/**
 * Rewrite a post's reference to `oldSlug` so it points at `category` (its new
 * slug + name), preserving the post's other categories and their order. If the
 * post already carried the new slug too, the duplicate is collapsed.
 *
 * Identity-stable: returns the SAME object when the post doesn't reference
 * `oldSlug` or already carries exactly this `{ name, slug }`. That is what
 * lets the name-edit cascade run `oldSlug === newSlug` without rewriting
 * every post.
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
  let changed = false;
  const mapped = categories.map((c) => {
    const slug = categorySlugOf(c);
    if (slug !== oldSlug && slug !== category.slug) return c;
    const rec = asRecord(c);
    if (
      rec &&
      str(rec.slug) === category.slug &&
      str(rec.name) === category.name
    ) {
      return c;
    }
    changed = true;
    return { name: category.name, slug: category.slug };
  });
  // Only skip the rest when there is also nothing to collapse: a post can
  // already carry the fresh ref twice, which the dedupe below is what fixes.
  if (!changed) {
    const slugs = categories.map(categorySlugOf).filter(Boolean);
    if (new Set(slugs).size === slugs.length) return payload;
  }
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
 * Which required fields a category payload is missing (empty ⇒ valid). A
 * category with no name or slug resolves to nothing on the site: the slug is
 * its URL and the name is what every post denormalizes. Mirrors
 * {@link missingPostFields}.
 */
export function missingCategoryFields(
  payload: Record<string, unknown>,
): MissingFieldKey[] {
  const missing: MissingFieldKey[] = [];
  if (!str(payload.name).trim()) missing.push("name");
  if (!str(payload.slug).trim()) missing.push("slug");
  return missing;
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
 * Point a child category at its parent's new slug. Pure: returns the SAME
 * object when this category isn't a child of `oldSlug`. Used by the category
 * slug-rename cascade — nesting is stored as a slug copy, so a rename that
 * skipped the children would orphan them.
 */
export function reparentCategory(
  payload: Record<string, unknown>,
  oldSlug: string,
  newSlug: string,
): Record<string, unknown> {
  if (str(payload.parentSlug) !== oldSlug) return payload;
  return { ...payload, parentSlug: newSlug };
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
  // Only the legacy names: an absent status already means published.
  const stored = str(payload.status);
  const normalized =
    stored === "idea" || stored === "in_review"
      ? { status: postStatus(payload) }
      : {};
  return { ...payload, ...normalized, dateModified: new Date().toISOString() };
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
        url: "",
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

/** How a caller narrows the blocks a post may be written with. */
export interface BlogBlockDiscoveryOptions {
  /** Drop the `deco-cms/blog` built-ins — the `hide_default_blog_blocks` flag. */
  hideDefaults?: boolean;
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
 * Some site schemas leave `@title`/`@description` as the raw resolveType (e.g.
 * "site/sections/Blog/Post/BlockImage.tsx"). That is a path, not a label — drop
 * it so the friendly catalog name shows instead.
 */
function humanLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.includes("/") || /\.(tsx?|jsx?)$/.test(value)) return undefined;
  return value;
}

/** "BlockImage" -> "Block image", "ProductShelf" -> "Product shelf". */
function humanizeComponentName(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!spaced) return name;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Title, description and icon for one blog block, with the precedence
 * described in KNOWN_BLOG_BLOCK_CATALOG. Callers that only hold a stored
 * block's `__resolveType` (the generic block editor) use this to name what is
 * being edited; the inserter builds its whole list from it.
 */
export function blogBlockTypeFor(
  resolveType: string,
  meta: LiveMeta,
): BlogBlockType {
  const md = resolveBlockSchemaMetadata(resolveType, meta);
  const name = blockComponentName(resolveType);
  const catalog = KNOWN_BLOG_BLOCK_CATALOG[name];
  const source = blogBlockSource(resolveType);

  // Site schema label wins, but only a real one — never a path-like default.
  const mdTitle = humanLabel(md.title);
  const mdDescription = humanLabel(md.description);
  const title =
    (source === "site"
      ? pick(mdTitle, catalog?.title)
      : pick(catalog?.title, mdTitle)) ?? humanizeComponentName(name);
  const description =
    source === "site"
      ? pick(mdDescription, catalog?.description)
      : pick(catalog?.description, mdDescription);

  // Only a site block's `@icon` is trusted: built-in schemas carry no icon hint.
  const rawIcon = source === "site" ? md.icon : undefined;
  const iconUrl = rawIcon && isImageUrl(rawIcon) ? rawIcon : undefined;
  const iconName =
    iconUrl !== undefined
      ? (catalog?.iconName ?? FALLBACK_BLOG_BLOCK_ICON)
      : (pick(rawIcon, catalog?.iconName) ?? FALLBACK_BLOG_BLOCK_ICON);

  return { resolveType, title, description, iconName, iconUrl, source };
}

/**
 * Discover the content block types a post can contain from the live
 * manifest, with title/icon metadata for the inserter UI. Recognizes both
 * the `deco-cms/blog` app blocks (`blog/sections/blocks/*`) and
 * site-defined blog blocks (`site/sections/Blog/Post/*`), matching the
 * same set that `isBlogPostBlockResolveType` accepts everywhere else.
 */
export function discoverBlogBlockTypes(
  meta: LiveMeta,
  { hideDefaults = false }: BlogBlockDiscoveryOptions = {},
): BlogBlockType[] {
  const seen = new Set<string>();
  const out: BlogBlockType[] = [];
  const groups = meta.manifest?.blocks ?? {};
  for (const group of Object.values(groups)) {
    for (const resolveType of Object.keys(group)) {
      if (!isBlogPostBlockResolveType(resolveType) || seen.has(resolveType)) {
        continue;
      }
      if (hideDefaults && blogBlockSource(resolveType) === "app") continue;
      seen.add(resolveType);
      out.push(blogBlockTypeFor(resolveType, meta));
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

/** Where the blog's writing rules live, apart from the brand's identity. */
export const CONTEXT_BLOCK_KEY = "blog-manager-context";

/**
 * The split between the two blocks, in one place.
 *
 * Who the brand IS outlives any one channel and is worth stating once;
 * how the blog is WRITTEN belongs to the blog and changes with it. Keeping them
 * in separate files means a rewrite of the editorial rules never risks the
 * company's own facts, and each half is inferred by its own pass.
 */
export const BRAND_FIELDS = [
  "companyName",
  "description",
  "language",
  "storeUrl",
  "targetAudience",
  "values",
  "competitors",
  "keywords",
  "commercialPolicies",
  "specialDates",
] as const;

export const CONTEXT_FIELDS = [
  "tone",
  "dos",
  "avoid",
  "categories",
  "vocabulary",
  "voiceExamples",
] as const;

/**
 * A stored block as a record, or the shared empty one.
 *
 * The identity matters: {@link EMPTY_PAYLOAD}'s note applies here too — an
 * editor seeding a draft from an absent block must get the same reference every
 * render, or `useAutosave` re-seeds forever.
 */
export function asBlock(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? EMPTY_PAYLOAD;
}

/**
 * A draft narrowed to the fields its block owns.
 *
 * The editor seeds each draft from a whole stored block — which, on a site
 * written before the split, is the one block holding both halves. Narrowing on
 * the way out is what keeps a save from writing a field into the wrong file,
 * and what makes the legacy block shed the rules it no longer owns.
 */
export function pickBlogFields(
  source: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in source) picked[field] = source[field];
  }
  return picked;
}

export interface BlogContextBlocks {
  brand: Record<string, unknown>;
  context: Record<string, unknown>;
  /** Both halves together — what every generation tool is fed. */
  merged: Record<string, unknown>;
}

/**
 * Both halves of the editorial context, from the two raw blocks. The one place
 * either is interpreted.
 *
 * Sites written before the split hold everything in `blog-manager-brand`, so
 * the writing rules fall back to it while `blog-manager-context` is absent —
 * the same tolerance {@link normalizeBrandRules} gives the older `string[]`
 * rule lists, and for the same reason: a read that copes costs one function,
 * a migration costs a pass over every site's repository. Once the context block
 * exists it wins outright, and the brand half is read by its own fields only,
 * so the legacy copies are ignored from then on and the brand block sheds them
 * on its next save.
 *
 * Takes the blocks rather than the decofile so a caller holding them as state
 * can memoize on their identity: it returns fresh objects, and the editor's
 * autosave re-seeds on reference change.
 */
export function splitBlogContext(
  brandBlock: unknown,
  contextBlock: unknown,
): BlogContextBlocks {
  const stored = asRecord(brandBlock) ?? {};
  const storedContext = asRecord(contextBlock);
  const brand = pickBlogFields(stored, BRAND_FIELDS);
  const context = storedContext ?? pickBlogFields(stored, CONTEXT_FIELDS);
  return { brand, context, merged: { ...brand, ...context } };
}

/** {@link splitBlogContext} for the callers that hold the whole decofile. */
export function readBlogContext(
  decofile: Record<string, unknown>,
): BlogContextBlocks {
  return splitBlogContext(
    decofile[BRAND_BLOCK_KEY],
    decofile[CONTEXT_BLOCK_KEY],
  );
}

/**
 * The editorial context as every generation tool takes it: one `brand` input
 * spanning both blocks, with blank rule rows dropped — those are editor state,
 * not something to spend a prompt on.
 *
 * Takes `merged` from {@link splitBlogContext}. The tools' schema is partial,
 * so a field the human never filled simply arrives empty.
 */
export function contextForTools(merged: Record<string, unknown>) {
  return {
    companyName: str(merged.companyName),
    description: str(merged.description),
    language: str(merged.language),
    // Normalised here so no tool ever receives an unusable address: a prompt
    // that composes links from a half-typed host produces links nobody can open.
    storeUrl: sanitizeSiteUrl(str(merged.storeUrl)) ?? "",
    tone: str(merged.tone),
    targetAudience: str(merged.targetAudience),
    values: filledBrandRules(normalizeBrandRules(merged.values)),
    competitors: filledBrandRules(normalizeBrandRules(merged.competitors)),
    specialDates: filledBrandRules(normalizeBrandRules(merged.specialDates)),
    dos: filledBrandRules(normalizeBrandRules(merged.dos)),
    avoid: filledBrandRules(normalizeBrandRules(merged.avoid)),
    keywords: filledTerms(normalizeTerms(merged.keywords)),
    commercialPolicies: filledBrandRules(
      normalizeBrandRules(merged.commercialPolicies),
    ),
    vocabulary: filledBrandRules(normalizeBrandRules(merged.vocabulary)),
    voiceExamples: filledVoiceExamples(
      normalizeVoiceExamples(merged.voiceExamples),
    ),
  };
}

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
 * One example sentence, with the side of the line it sits on. Not a
 * {@link BrandRule}: there is no rule to name here, only the sentence and
 * whether it is one to imitate or one to avoid.
 */
export interface VoiceExample {
  text: string;
  sounds: boolean;
}

/**
 * Read example sentences from a block, tolerating the `{ name, value }` shape
 * this field briefly had — those rows carried the sentence in `value`, so they
 * survive as sentences to imitate rather than being dropped.
 */
export function normalizeVoiceExamples(value: unknown): VoiceExample[] {
  if (!Array.isArray(value)) return [];
  const examples: VoiceExample[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      if (entry.trim()) examples.push({ text: entry, sounds: true });
      continue;
    }
    const record = asRecord(entry);
    if (!record) continue;
    const text = str(record.text) || str(record.value);
    examples.push({ text, sounds: record.sounds !== false });
  }
  return examples;
}

/** Examples a reader would consider written — a blank row is editor state. */
export function filledVoiceExamples(examples: VoiceExample[]): VoiceExample[] {
  return examples.filter((example) => example.text.trim());
}

/** Whether a fill may overwrite what a person already wrote. */
export type FillMode = "empty" | "replace";

/**
 * Write an extract's answer into a draft, returning the fields it touched.
 *
 * `empty` fills blanks only. `replace` overwrites a field the model answered —
 * but a field it left empty keeps its current value, because deleting someone's
 * sentence to put nothing in its place is never what "start over" is asking
 * for. Mutates `target`, which the caller owns as a fresh copy.
 */
export function applyExtractResult(
  target: Record<string, unknown>,
  result: Record<string, unknown>,
  options: {
    mode: FillMode;
    textFields: readonly string[];
    ruleFields: readonly string[];
    /** Fields holding {@link VoiceExample}s, which normalize differently. */
    exampleFields?: readonly string[];
    /** Fields holding a plain `string[]`, which normalize differently again. */
    termFields?: readonly string[];
  },
): string[] {
  const touched: string[] = [];
  for (const field of options.textFields) {
    const proposed = str(result[field]).trim();
    if (!proposed) continue;
    if (options.mode === "empty" && str(target[field]).trim()) continue;
    target[field] = proposed;
    touched.push(field);
  }
  for (const field of options.ruleFields) {
    const proposed = filledBrandRules(normalizeBrandRules(result[field]));
    if (proposed.length === 0) continue;
    if (
      options.mode === "empty" &&
      filledBrandRules(normalizeBrandRules(target[field])).length > 0
    ) {
      continue;
    }
    target[field] = proposed;
    touched.push(field);
  }
  for (const field of options.termFields ?? []) {
    const proposed = filledTerms(normalizeTerms(result[field]));
    if (proposed.length === 0) continue;
    if (
      options.mode === "empty" &&
      filledTerms(normalizeTerms(target[field])).length > 0
    ) {
      continue;
    }
    target[field] = proposed;
    touched.push(field);
  }
  for (const field of options.exampleFields ?? []) {
    const proposed = filledVoiceExamples(normalizeVoiceExamples(result[field]));
    if (proposed.length === 0) continue;
    if (
      options.mode === "empty" &&
      filledVoiceExamples(normalizeVoiceExamples(target[field])).length > 0
    ) {
      continue;
    }
    target[field] = proposed;
    touched.push(field);
  }
  return touched;
}

/**
 * Read a plain term list, tolerating the `{name, value}` rows this field held
 * before it became a list of search terms. The object's `name` was the term, so
 * it carries over and the block picks up the new shape on the next save — no
 * migration, the same way {@link normalizeBrandRules} absorbed the shape before
 * it.
 *
 * Keeping `keywords` out of the rule-field path is load-bearing, not tidiness:
 * {@link normalizeBrandRules} happily maps a bare string back to
 * `{name, value}`, so routing terms through it would silently re-objectify them
 * on the next autosave and undo the change with no error anywhere.
 */
export function normalizeTerms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const terms: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      terms.push(entry);
      continue;
    }
    const record = asRecord(entry);
    if (!record) continue;
    terms.push(str(record.name) || str(record.value));
  }
  return terms;
}

/** Terms a reader would consider written — see {@link filledBrandRules}. */
export function filledTerms(terms: string[]): string[] {
  return terms.filter((term) => term.trim());
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

export interface BrandEvidence {
  blocks: BrandEvidenceBlock[];
  seo: SeoEvidenceEntry[];
}

/**
 * Everything the extract reads, most telling first: posts, then categories, then pages — home, institutional, commerce. A PDP is a template with a product name substituted in, so the thousandth teaches nothing the first did not; an institutional page is written once, by hand, about the brand. SEO travels in its own array because folded into `blocks` it could trip `BRAND_EVIDENCE_MAX_BLOCKS`, which rejects the whole call.
 */
export function selectBrandEvidence(
  decofile: Record<string, unknown>,
  pages: PageEntry[],
): BrandEvidence {
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

  const seo = selectSeoEvidence(decofile, pages);
  const seoChars = seo.reduce((sum, entry) => sum + entry.content.length, 0);

  const byRole: Record<PageRole, string[]> = {
    home: [],
    institutional: [],
    commerce: [],
  };
  for (const page of pages) byRole[pageRole(decofile, page)].push(page.key);

  const ordered = [
    ...listBlogPayloads(decofile, "posts")
      .map((p) => p.key)
      .sort(byProseDesc),
    ...listBlogPayloads(decofile, "categories").map((c) => c.key),
    ...byRole.home,
    ...byRole.institutional.sort(byProseDesc),
    ...byRole.commerce.sort(byProseDesc),
  ];

  const selected: BrandEvidenceBlock[] = [];
  const seen = new Set<string>();
  let remaining = Math.max(0, BRAND_EVIDENCE_MAX_CHARS - seoChars);

  for (const key of ordered) {
    if (selected.length >= BRAND_EVIDENCE_MAX_BLOCKS) break;
    if (seen.has(key)) continue;
    if (!decofile[key]) continue;
    seen.add(key);
    const content = proseFor(key);
    if (content.length > remaining) break;
    selected.push({ key, content });
    remaining -= content.length;
  }

  return { blocks: selected, seo };
}

// ------------------ Campaigns (temporary pillars) ----------------------------

/**
 * A campaign is a content pillar with an end date.
 *
 * The durable territory a brand always returns to already lives in the brand
 * context — its values, its keywords, its calendar. What pulls a post into
 * existence is a moment: Black Friday 2026, a line launching, a search the
 * brand does not answer, stock that has to move. A campaign is that moment,
 * named, with the targeting and guardrails a generated post needs.
 *
 * Studio-only planning blocks (no `__resolveType`), one per block under this
 * prefix so a write never clobbers the campaign being edited. Replaces
 * `blog-manager/pillars/`, which is no longer read.
 */
export const CAMPAIGN_KEY_PREFIX = "blog-manager/campaigns/";

/**
 * The closed sets live in `@decocms/shared` because `BLOG_CAMPAIGN_SUGGEST`
 * narrows the model's output against the very same lists. Re-exported here so
 * every call site in this folder keeps importing campaign things from one place.
 */
export {
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TARGET_KINDS,
  CAMPAIGN_TRIGGERS,
  MAX_CAMPAIGN_PRODUCT_IMAGES,
  type CampaignObjective,
  type CampaignStatus,
  type CampaignTargetKind,
  type CampaignTrigger,
};

/**
 * The slice of the store a campaign covers — never a single product. Picking a
 * product here would collapse two different things into one: the target is the
 * scope the campaign argues for, while `products` is what the copy may name.
 * A campaign needs the highlighted products whatever its target is.
 *
 * `id` is whatever the storefront calls it and may be empty when typed by hand;
 * the URL is what makes a target real, because it is the one thing every
 * storefront has and the only one a reader can open.
 */
export interface CampaignTarget {
  kind: CampaignTargetKind;
  id: string;
  name: string;
  url: string;
  description: string;
}

/**
 * A product the campaign wants named in the copy. Copied into the block rather
 * than referenced by id: generation reads this months later, and a stored id
 * only answers while that storefront is up and still issuing it.
 */
export interface CampaignProduct {
  id: string;
  name: string;
  url: string;
  /** Up to `MAX_CAMPAIGN_PRODUCT_IMAGES`; the post picks one to run with. */
  images: string[];
  /** The product's main category, as the storefront reports it. */
  category: string;
  description: string;
}

export interface CampaignEntry {
  key: string;
  name: string;
  /** The seed this campaign was generated from; "" when written by hand. */
  seedKey: string;
  status: CampaignStatus;
  /** `YYYY-MM-DD`, both optional — not every campaign has dates pinned. */
  period: { start: string | null; end: string | null };
  trigger: { type: CampaignTrigger; note: string };
  intent: {
    objective: CampaignObjective;
    targets: CampaignTarget[];
    /** Highlighted products — asked for whatever the target kind is. */
    products: CampaignProduct[];
    keywords: string[];
  };
  guardrails: {
    /** Added to the context's `avoid`, never replacing it. */
    avoidComplements: BrandRule[];
    /** Replaces the brand's `tone` while this campaign runs. */
    toneOverrides: string;
  };
  createdAt: string;
  updatedAt: string;
}

export function newCampaignKey(): string {
  return `${CAMPAIGN_KEY_PREFIX}${crypto.randomUUID()}`;
}

/** A stored value narrowed to a closed set, or the default. */
function oneOf<T extends string>(
  allowed: readonly T[],
  value: unknown,
  fallback: T,
): T {
  return allowed.find((option) => option === value) ?? fallback;
}

/** A date the editor wrote, or null — never an empty string downstream. */
function dateOrNull(value: unknown): string | null {
  return str(value) || null;
}

export function readCampaignTargets(value: unknown): CampaignTarget[] {
  const targets: CampaignTarget[] = [];
  for (const entry of toArray(value)) {
    const record = asRecord(entry);
    if (!record) continue;
    targets.push({
      kind: oneOf(CAMPAIGN_TARGET_KINDS, record.kind, "category"),
      id: str(record.id),
      name: str(record.name),
      url: str(record.url),
      description: str(record.description),
    });
  }
  return targets;
}

/**
 * Image URLs, capped. Tolerates the single `image` an earlier shape wrote.
 *
 * Blanks are kept: the editor re-reads the draft through here on every render,
 * so dropping an empty slot would delete the row "add image" had just created,
 * before anyone could type into it.
 */
function readProductImages(record: Record<string, unknown>): string[] {
  const listed = toArray(record.images).map((entry) => str(entry));
  const all = listed.length > 0 ? listed : [str(record.image)].filter(Boolean);
  return all.slice(0, MAX_CAMPAIGN_PRODUCT_IMAGES);
}

export function readCampaignProducts(value: unknown): CampaignProduct[] {
  const products: CampaignProduct[] = [];
  for (const entry of toArray(value)) {
    const record = asRecord(entry);
    if (!record) continue;
    products.push({
      id: str(record.id),
      name: str(record.name),
      url: str(record.url),
      images: readProductImages(record),
      category: str(record.category),
      description: str(record.description),
    });
  }
  return products;
}

/**
 * Rebuild a campaign block. Every optional is coalesced rather than omitted, so
 * the JSON on disk has one shape whatever the editor had filled in.
 *
 * `campaignName` rather than `name`, because `name` is the block-key field
 * every planning block carries.
 */
export function buildCampaignBlock(
  key: string,
  campaign: Omit<CampaignEntry, "key">,
): Record<string, unknown> {
  return {
    name: key,
    campaignName: campaign.name,
    seedKey: campaign.seedKey,
    status: campaign.status,
    period: {
      start: campaign.period.start ?? "",
      end: campaign.period.end ?? "",
    },
    trigger: { type: campaign.trigger.type, note: campaign.trigger.note },
    intent: {
      objective: campaign.intent.objective,
      targets: campaign.intent.targets,
      products: campaign.intent.products,
      keywords: campaign.intent.keywords,
    },
    guardrails: {
      avoidComplements: campaign.guardrails.avoidComplements,
      toneOverrides: campaign.guardrails.toneOverrides,
    },
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  };
}

/**
 * Every campaign, newest first.
 *
 * Tolerant of a partial block: a half-written campaign is
 * the normal case while someone is still filling the form, and an unknown enum
 * value reads as the default rather than breaking the board.
 */
export function scanCampaigns(
  decofile: Record<string, unknown>,
): CampaignEntry[] {
  const campaigns: CampaignEntry[] = [];
  for (const [key, value] of Object.entries(decofile)) {
    if (!key.startsWith(CAMPAIGN_KEY_PREFIX)) continue;
    const record = asRecord(value);
    if (!record) continue;
    const period = asRecord(record.period) ?? {};
    const trigger = asRecord(record.trigger) ?? {};
    const intent = asRecord(record.intent) ?? {};
    const guardrails = asRecord(record.guardrails) ?? {};
    campaigns.push({
      key,
      name: str(record.campaignName),
      seedKey: str(record.seedKey),
      status: oneOf(CAMPAIGN_STATUSES, record.status, "draft"),
      period: { start: dateOrNull(period.start), end: dateOrNull(period.end) },
      trigger: {
        type: oneOf(CAMPAIGN_TRIGGERS, trigger.type, "seasonal"),
        note: str(trigger.note),
      },
      intent: {
        objective: oneOf(CAMPAIGN_OBJECTIVES, intent.objective, "awareness"),
        targets: readCampaignTargets(intent.targets),
        products: readCampaignProducts(intent.products),
        keywords: filledTerms(normalizeTerms(intent.keywords)),
      },
      guardrails: {
        avoidComplements: normalizeBrandRules(guardrails.avoidComplements),
        toneOverrides: str(guardrails.toneOverrides),
      },
      createdAt: str(record.createdAt),
      updatedAt: str(record.updatedAt),
    });
  }
  return campaigns.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name),
  );
}

/** A campaign as it is born: empty, in draft, nothing pinned. */
export function emptyCampaign(now: Date): Omit<CampaignEntry, "key"> {
  const stamp = now.toISOString();
  return {
    name: "",
    seedKey: "",
    status: "draft",
    period: { start: null, end: null },
    trigger: { type: "seasonal", note: "" },
    intent: { objective: "awareness", targets: [], products: [], keywords: [] },
    guardrails: { avoidComplements: [], toneOverrides: "" },
    createdAt: stamp,
    updatedAt: stamp,
  };
}

// ------------------ Campaign seeds (what a generation starts from) -----------

export const CAMPAIGN_SEED_KEY_PREFIX = "blog-manager/campaign-seeds/";

/**
 * What a campaign generation starts from: the terms to aim at and the sentence
 * saying what the moment is.
 *
 * Stored rather than kept in the dialog because the generation reaches the
 * brand's own systems, and the answer changes as the store does — a seed worth
 * writing once is worth running again next quarter. Campaigns point back at it
 * through `seedKey`.
 */
export interface CampaignSeedEntry {
  key: string;
  name: string;
  keywords: string[];
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

export function newCampaignSeedKey(): string {
  return `${CAMPAIGN_SEED_KEY_PREFIX}${crypto.randomUUID()}`;
}

export function buildCampaignSeedBlock(
  key: string,
  seed: Omit<CampaignSeedEntry, "key">,
): Record<string, unknown> {
  return {
    name: key,
    seedName: seed.name,
    keywords: seed.keywords,
    prompt: seed.prompt,
    createdAt: seed.createdAt,
    updatedAt: seed.updatedAt,
  };
}

/** Every seed, newest first. Tolerant of a partial block, like its siblings. */
export function scanCampaignSeeds(
  decofile: Record<string, unknown>,
): CampaignSeedEntry[] {
  const seeds: CampaignSeedEntry[] = [];
  for (const [key, value] of Object.entries(decofile)) {
    if (!key.startsWith(CAMPAIGN_SEED_KEY_PREFIX)) continue;
    const record = asRecord(value);
    if (!record) continue;
    seeds.push({
      key,
      name: str(record.seedName),
      keywords: filledTerms(normalizeTerms(record.keywords)),
      prompt: str(record.prompt),
      createdAt: str(record.createdAt),
      updatedAt: str(record.updatedAt),
    });
  }
  return seeds.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name),
  );
}

export function emptyCampaignSeed(now: Date): Omit<CampaignSeedEntry, "key"> {
  const stamp = now.toISOString();
  return {
    name: "",
    keywords: [],
    prompt: "",
    createdAt: stamp,
    updatedAt: stamp,
  };
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
  /** The label a citation shows: `ProductShelf`. */
  name: string;
  /** What the citation actually points at — the block it resolves to. */
  resolveType: string;
  title: string;
  description?: string;
}

/**
 * The sections a format's brief may cite.
 *
 * Every discovered block, not one per component name: a site that overrides an
 * app block has two `Heading`s, and they are different blocks. Collapsing them
 * was only tenable while a citation was the bare name, which could not tell
 * them apart; now that it carries the `resolveType` they are distinguishable,
 * and hiding one meant a brief could never cite it.
 */
export function mentionableSections(
  meta: LiveMeta,
  options?: BlogBlockDiscoveryOptions,
): MentionableSection[] {
  return discoverBlogBlockTypes(meta, options).map((block) => ({
    name: blockComponentName(block.resolveType),
    resolveType: block.resolveType,
    title: block.title,
    description: block.description,
  }));
}

/**
 * The blocks a brief cites, as resolveTypes.
 *
 * A citation is the markdown link `[@Heading](<resolveType>)` — the same shape
 * `@decocms/shared/mentions` uses for people, and for the same reason: a
 * component name repeats across an app block and a site's override of it, so
 * which block renders must not depend on the name.
 *
 * A bare `@Name` still reads, because briefs written before this and briefs a
 * model writes both use it. It resolves through `byName` when the site has that
 * component, and is returned as-is when it does not, so an unknown citation
 * stays visible as one.
 */
export function citedSections(
  markdown: string,
  byName: Record<string, string> = {},
): string[] {
  const cited = new Set<string>();
  const linked = /\[@[^\]]+\]\(([^)\s]+)\)/g;
  for (const match of markdown.matchAll(linked)) {
    if (match[1]) cited.add(match[1]);
  }
  const bare = /(?:^|[\s([{>])@([A-Za-z][\w-]*)/g;
  for (const match of markdown.replace(linked, " ").matchAll(bare)) {
    const name = match[1];
    if (name) cited.add(byName[name] ?? name);
  }
  return [...cited];
}

/**
 * Cited blocks the site no longer has. Without surfacing these, a format keeps
 * pointing at a renamed section and only the generated post shows it.
 */
export function unknownCitations(
  markdown: string,
  available: string[],
  byName: Record<string, string> = {},
): string[] {
  const known = new Set(available);
  return citedSections(markdown, byName).filter((ref) => !known.has(ref));
}

/**
 * Rewrite bare `@Name` citations into the linked form.
 *
 * Run over whatever a model proposes and over the starter format, so one shape
 * is persisted no matter who wrote the brief. A name this site has no block for
 * is left alone — turning it into a link would invent a target, and leaving it
 * bare is what keeps `unknownCitations` able to report it.
 */
export function linkifyCitations(
  markdown: string,
  byName: Record<string, string>,
): string {
  const linked = /\[@[^\]]+\]\([^)\s]+\)/g;
  const parts: string[] = [];
  let last = 0;
  for (const match of markdown.matchAll(linked)) {
    const at = match.index ?? 0;
    parts.push(linkifyBare(markdown.slice(last, at), byName), match[0]);
    last = at + match[0].length;
  }
  parts.push(linkifyBare(markdown.slice(last), byName));
  return parts.join("");
}

function linkifyBare(text: string, byName: Record<string, string>): string {
  return text.replace(
    /(^|[\s([{>])@([A-Za-z][\w-]*)/g,
    (whole, before: string, name: string) => {
      const resolveType = byName[name];
      return resolveType ? `${before}[@${name}](${resolveType})` : whole;
    },
  );
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

export function defaultFormatSections(
  byName: Record<string, string>,
): string[] {
  return DEFAULT_FORMAT_SECTIONS.filter((name) => name in byName);
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
 * Whether another record of `kind` already carries `name`, comparing on
 * {@link normalizeTitleKey} so casing, accents and spacing don't hide a clash.
 * An empty name is never a duplicate — that is the "missing field" guard's job.
 *
 * Takes the name separately from the decofile so an editor can ask about the
 * draft the author is still typing, not the last autosaved value.
 */
export function hasDuplicateName(
  decofile: Record<string, unknown>,
  kind: BlogKind,
  blockKey: string,
  name: string,
): boolean {
  const key = normalizeTitleKey(name);
  if (!key) return false;
  return namedRecords(decofile, kind).some(
    (record) =>
      record.key !== blockKey && normalizeTitleKey(record.name) === key,
  );
}

/**
 * Every record of `kind` paired with its RAW name — no "Untitled" fallback,
 * which would make two nameless records look like a collision.
 *
 * Posts come in two physical forms and both count: a planning draft carries no
 * `__resolveType`, so `listBlogPayloads` alone misses the whole board.
 */
function namedRecords(
  decofile: Record<string, unknown>,
  kind: BlogKind,
): Array<{ key: string; name: string }> {
  if (kind !== "posts") {
    return listBlogPayloads(decofile, kind).map(({ key, payload }) => ({
      key,
      name: str(payload.name),
    }));
  }
  return listAllPostPayloads(decofile).map(({ key, payload }) => ({
    key,
    name: str(payload.title),
  }));
}

/** Block keys of posts whose non-empty title collides with another post's. */
export function duplicateTitleKeys(
  decofile: Record<string, unknown>,
): Set<string> {
  const byKey = new Map<string, string[]>();
  for (const { key, name } of namedRecords(decofile, "posts")) {
    const normalized = normalizeTitleKey(name);
    if (!normalized) continue;
    const keys = byKey.get(normalized);
    keys ? keys.push(key) : byKey.set(normalized, [key]);
  }
  const duplicates = new Set<string>();
  for (const keys of byKey.values()) {
    if (keys.length > 1) for (const key of keys) duplicates.add(key);
  }
  return duplicates;
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
 * What the merged context ({@link readBlogContext}) still lacks before anything may be generated.
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
 * The `required` names this schema still declares a property for.
 *
 * deco wraps a block's config as `{ properties: {__resolveType}, required:
 * ["__resolveType"], allOf: [{$ref: Props}] }`, and `resolveSchema` drops every
 * `__`-prefixed key from `properties` while keeping `required` whole. What
 * comes out demands a property it does not declare — and `__resolveType` is the
 * one thing the writer is never shown, so every section it wrote failed
 * validation on a field it could not have known to write.
 */
function requiredOf(
  source: Record<string, unknown>,
  properties: unknown,
): string[] | undefined {
  const names = source.required;
  if (!Array.isArray(names)) return undefined;
  const declared = new Set(
    properties && typeof properties === "object"
      ? Object.keys(properties as Record<string, unknown>)
      : [],
  );
  const kept = names.filter(
    (name): name is string => typeof name === "string" && declared.has(name),
  );
  return kept.length > 0 ? kept : undefined;
}

/** How deep a `$ref` chain is followed before a branch is left unresolved. */
const MAX_SCHEMA_DEPTH = 6;

/** How much of one block's schema travels. A `Product` ref expands forever. */
const MAX_BLOCK_SCHEMA_CHARS = 6_000;

function definitionsOf(meta: LiveMeta): Record<string, unknown> {
  const schema = (meta.schema ?? {}) as Record<string, unknown>;
  const defs = schema.$defs ?? schema.definitions;
  return defs && typeof defs === "object"
    ? (defs as Record<string, unknown>)
    : {};
}

function manifestEntry(resolveType: string, meta: LiveMeta): unknown {
  for (const group of Object.values(meta.manifest?.blocks ?? {})) {
    const entry = (group as Record<string, unknown>)[resolveType];
    if (entry) return entry;
  }
  return undefined;
}

/** Follow `$ref` through the live meta's own definitions, bounded. */
function deref(
  node: unknown,
  defs: Record<string, unknown>,
  depth: number,
): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) => deref(entry, defs, depth));
  }
  if (!node || typeof node !== "object") return node;
  const record = node as Record<string, unknown>;

  if (typeof record.$ref === "string") {
    if (depth >= MAX_SCHEMA_DEPTH) return {};
    const key = record.$ref.split("/").pop() ?? "";
    const target = defs[key];
    if (target === undefined) return {};
    return deref(target, defs, depth + 1);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = deref(value, defs, depth);
  }
  return out;
}

/**
 * A block's own JSON Schema, read from the live meta rather than rebuilt.
 *
 * `resolveSchema` is the editor's view: it exists to render a form, so it
 * flattens what a form cannot show. A `string | string[]` prop comes out of it
 * typed `object` — and a writer handed that writes an object, which is how a
 * list the site stores as one newline-joined string came back as a map.
 *
 * The meta carries the real thing. deco wraps a block as
 * `{ allOf: [{$ref: Props}], properties: {__resolveType}, required: [...] }`,
 * so the props schema is one hop in: its `anyOf`, its `format`, its `options`
 * loader and its descriptions all survive, which is everything the writer
 * needs and none of what the form needed.
 */
export function rawBlockSchema(
  resolveType: string,
  meta: LiveMeta,
): Record<string, unknown> {
  const defs = definitionsOf(meta);
  const wrapper = deref(manifestEntry(resolveType, meta), defs, 0);
  if (!wrapper || typeof wrapper !== "object") return {};

  const record = wrapper as Record<string, unknown>;
  const allOf = record.allOf;
  const props = Array.isArray(allOf) && allOf.length === 1 ? allOf[0] : record;
  if (!props || typeof props !== "object") return {};

  const { $schema: _schema, ...rest } = props as Record<string, unknown>;
  const trimmed = withoutPlumbing(rest);
  return JSON.stringify(trimmed).length > MAX_BLOCK_SCHEMA_CHARS
    ? withoutPlumbing(rest, true)
    : trimmed;
}

/** `__resolveType` is the caller's to stamp, so it never reaches the writer. */
function withoutPlumbing(
  schema: Record<string, unknown>,
  shallow = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };
  const properties = out.properties;
  if (properties && typeof properties === "object") {
    const kept = Object.fromEntries(
      Object.entries(properties as Record<string, unknown>)
        .filter(([name]) => !name.startsWith("__"))
        .map(([name, value]) => [name, shallow ? shallowProp(value) : value]),
    );
    out.properties = kept;
    out.required = requiredOf(out, kept);
    if (!out.required) delete out.required;
  }
  return out;
}

/** A prop stripped to what it is, for a schema too big to send whole. */
function shallowProp(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const prop = value as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of ["type", "description", "format", "options", "enum"]) {
    if (key in prop) kept[key] = prop[key];
  }
  if (Array.isArray(prop.anyOf)) kept.anyOf = prop.anyOf.map(shallowProp);
  return kept;
}

/** The JSON type of a stored value, as a schema would name it. */
function jsonType(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  return t === "number" || t === "boolean" || t === "string" || t === "object"
    ? t
    : null;
}

/**
 * The schema, with the assertions a real block disproves taken out.
 *
 * Both halves are evidence and they do not always agree: a `List` whose `$ref`
 * did not resolve is typed `object` by `resolveSchema`'s last-resort branch,
 * while every one the site renders stores a newline-joined string. Telling the
 * writer to follow the example and then validating against the schema is a
 * contradiction that costs the section either way.
 *
 * So a stored block wins on its own properties: where the two disagree, the
 * schema's `type` and `enum` for that property come out and the rest stays. It
 * is narrow on purpose — the example disproves what it covers, nothing more.
 */
export function reconciledSchema(
  schema: Record<string, unknown>,
  example: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const properties = schema.properties;
  if (!example || !properties || typeof properties !== "object") return schema;

  const source = properties as Record<string, unknown>;
  let changed = false;
  const reconciled: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(source)) {
    const prop = raw && typeof raw === "object" ? { ...raw } : raw;
    const declared = (prop as Record<string, unknown> | null)?.type;
    const stored = jsonType(example[name]);
    if (
      prop &&
      typeof prop === "object" &&
      stored &&
      typeof declared === "string" &&
      declared !== stored
    ) {
      delete (prop as Record<string, unknown>).type;
      delete (prop as Record<string, unknown>).enum;
      changed = true;
    }
    reconciled[name] = prop;
  }
  return changed ? { ...schema, properties: reconciled } : schema;
}

/** One block the writer may build a section from, with its own typing. */
export interface GenerationBlock {
  name: string;
  title: string;
  description: string;
  schema: Record<string, unknown>;
  /** How this site already stores the block, when it has one to show. */
  example?: Record<string, unknown>;
}

/** How long an example may be before it costs more prompt than it teaches. */
const MAX_EXAMPLE_CHARS = 600;

/**
 * One of this block as the site already stores it.
 *
 * The derived schema is not always the truth. A prop whose `$ref` did not
 * resolve comes out of `resolveSchema` typed `object` with no properties —
 * a guess, and one a writer acts on: a `List` that stores its items as one
 * newline-joined string was handed a schema saying "object" and dutifully
 * wrote a map. An existing post is what actually renders, so it settles the
 * shape where the schema only describes it.
 *
 * Live posts first: a planning post may itself have been generated wrong, and
 * copying our own mistake back in would make it permanent.
 */
export function blockExample(
  resolveType: string,
  decofile: Record<string, unknown>,
): Record<string, unknown> | undefined {
  for (const { payload } of listBlogPayloads(decofile, "posts")) {
    for (const raw of toArray(payload.sections)) {
      const section = asRecord(raw);
      if (!section || section.__resolveType !== resolveType) continue;
      const { __resolveType: _type, ...props } = section;
      if (Object.keys(props).length === 0) continue;
      if (JSON.stringify(props).length > MAX_EXAMPLE_CHARS) continue;
      return props;
    }
  }
  return undefined;
}

/**
 * The blocks a format admits, each carrying the schema its props must match.
 *
 * The format's brief already cites what this brand reaches for — that citation
 * is what picks the set, so a format is a contract rather than a suggestion.
 * A brief that cites nothing falls back to every block the site exposes: a
 * loosely written format must not leave a post with nothing to be made of.
 *
 * Several blocks can share a component name (a site's override of an app
 * block). The writer only ever sees the name, so the first wins here the same
 * way it does in {@link sectionResolveTypes} — the two must agree, or a section
 * would be written against one schema and saved as another.
 */
export function blocksForFormat(
  format: { value: string },
  meta: LiveMeta,
  decofile: Record<string, unknown>,
  options?: BlogBlockDiscoveryOptions,
): GenerationBlock[] {
  const available = mentionableSections(meta, options);
  const byName = sectionResolveTypes(meta, options);
  const cited = new Set(citedSections(format.value, byName));
  const wanted = available.filter((section) => cited.has(section.resolveType));
  const chosen = wanted.length > 0 ? wanted : available;

  const seen = new Set<string>();
  const blocks: GenerationBlock[] = [];
  for (const section of chosen) {
    if (seen.has(section.name)) continue;
    if (byName[section.name] !== section.resolveType) continue;
    seen.add(section.name);
    const example = blockExample(section.resolveType, decofile);
    blocks.push({
      name: section.name,
      title: section.title,
      description: section.description ?? "",
      schema: reconciledSchema(
        rawBlockSchema(section.resolveType, meta),
        example,
      ),
      example,
    });
  }
  return blocks;
}

/**
 * Component name → the resolveType this site actually exposes for it.
 *
 * A generated section names its kind (`Heading`); only the site knows whether
 * that is `blog/sections/blocks/Heading.tsx` or its own
 * `site/sections/Blog/Post/Heading.tsx`. Keeping the mapping here means the
 * model never sees a resolveType and so can never invent one.
 */
export function sectionResolveTypes(
  meta: LiveMeta,
  options?: BlogBlockDiscoveryOptions,
): Record<string, string> {
  const byName: Record<string, string> = {};
  for (const block of discoverBlogBlockTypes(meta, options)) {
    const name = blockComponentName(block.resolveType);
    if (!(name in byName)) byName[name] = block.resolveType;
  }
  return byName;
}

type DraftSection =
  StudioToolIO["BLOG_POST_DRAFT"]["output"]["posts"][number]["sections"][number];

/**
 * Turn generated sections into decofile blocks.
 *
 * The props arrive already checked against the block's own JSON Schema, which
 * is what lets this be a spread. It used to be a switch with one case per kind,
 * encoding each block's storage convention by hand — a `List` keeps its items
 * as one newline-joined string — and that was only ever right for the blocks
 * the blog app ships. A site with its own section got the app's assumptions,
 * and a block that saves fine and renders empty is the worst way to be wrong.
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
    blocks.push({ __resolveType, ...section.props });
  }
  return blocks;
}

/** Longest slug a post may carry, suffix included. */
const SLUG_MAX_LENGTH = 80;

/** URL-safe slug from a title: accents folded, punctuation dropped. */
export function slugifyTitle(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH);
}

/** Slugify as the author types: keeps the trailing "-" `slugifyTitle` trims, or typing "meu-post" would eat the separator. */
export function maskSlugInput(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX_LENGTH);
}

/** `base-suffix`, shortening the base so the whole slug still fits the cap. */
function suffixSlug(base: string, suffix: string): string {
  const room = SLUG_MAX_LENGTH - suffix.length - 1;
  return `${base.slice(0, room).replace(/-+$/, "")}-${suffix}`;
}

/**
 * `slugifyTitle(source)`, suffixed until it stops colliding with `taken`.
 * `fallbackPrefix` names the random slug minted when `source` slugifies to
 * nothing at all (`"!!!"`), so each collection gets its own readable shape.
 */
export function uniqueSlug(
  source: string,
  taken: string[],
  fallbackPrefix: string,
): string {
  const base = slugifyTitle(source) || `${fallbackPrefix}-${randomHex(6)}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = suffixSlug(base, String(n));
    if (!used.has(candidate)) return candidate;
  }
  return suffixSlug(base, randomHex(4));
}

/** {@link uniqueSlug} for a post title. */
export function uniquePostSlug(title: string, taken: string[]): string {
  return uniqueSlug(title, taken, "post");
}

/** {@link uniqueSlug} for a category name. */
export function uniqueCategorySlug(source: string, taken: string[]): string {
  return uniqueSlug(source, taken, "category");
}

/** A freshly generated post: lands in Awaiting review, cover and all. */
export function buildGeneratedPostPayload({
  draft,
  resolveTypes,
  categories,
  authors,
  planning,
  takenSlugs,
  now,
}: {
  draft: StudioToolIO["BLOG_POST_DRAFT"]["output"]["posts"][number];
  resolveTypes: Record<string, string>;
  /** The site's categories, to resolve the chosen slugs into stored refs. */
  categories: CategoryRef[];
  /** The site's authors, to resolve the chosen emails into stored refs. */
  authors: AuthorRef[];
  /** The briefing the card was generated from, kept for the board card. */
  planning?: PlanningMeta;
  takenSlugs: string[];
  now: Date;
}): Record<string, unknown> {
  const chosenCategories = new Set(draft.categorySlugs);
  const chosenAuthors = new Set(draft.authorEmails);
  const payload: Record<string, unknown> = {
    title: draft.title,
    slug: uniquePostSlug(draft.title, takenSlugs),
    date: now.toISOString().slice(0, 10),
    excerpt: draft.excerpt,
    image: draft.cover.url,
    alt: draft.cover.alt,
    authors: authors.filter((author) => chosenAuthors.has(author.email)),
    categories: categories.filter((c) => chosenCategories.has(c.slug)),
    seo: {
      title: draft.seo.title,
      description: draft.seo.description,
      image: draft.cover.url,
    },
    sections: buildPostSections(draft.sections, resolveTypes),
    planning: (planning ?? {}) as Record<string, unknown>,
  };
  return setPostStatus(payload, "awaiting_review", now);
}
