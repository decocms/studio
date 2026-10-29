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
/** The block mapping, which `apps/api` also imports — it cannot import from here. */
import {
  asRecord,
  authorEmailOf,
  type AuthorRef,
  blockComponentName,
  blockExample,
  blocksForFormat,
  BLOG_KINDS,
  BLOG_SINGULAR,
  type BlogBlockDiscoveryOptions,
  type BlogBlockSource,
  type BlogBlockType,
  blogBlockTypeFor,
  type BlogEntry,
  type BlogKind,
  type BrandRule,
  buildBlogBlock,
  buildGeneratedPostPayload,
  buildPostSections,
  type CategoryRef,
  categorySlugOf,
  citedSections,
  DEFAULT_SCHEDULE_HOUR,
  defaultScheduledDatetime,
  discoverBlogBlockTypes,
  FORMATS_BLOCK_KEY,
  type GenerationBlock,
  getBlogPayload,
  isBlogKind,
  isBlogPostBlockResolveType,
  isPlanningPostKey,
  KNOWN_BLOG_BLOCK_EXAMPLES,
  listAuthorRefs,
  listBlogPayloads,
  livePostKey,
  maskSlugInput,
  missingCategoryFields,
  type MissingFieldKey,
  missingPostFields,
  newPostId,
  normalizeTitleKey,
  PLANNING_POST_KEY_PREFIX,
  type PlanningMeta,
  planningPostKey,
  POST_STATUSES,
  postIdOfKey,
  type PostStatus,
  postStatus,
  productSlotOf,
  randomHex,
  rawBlockSchema,
  reconciledSchema,
  RESOLVE_TYPE_FOR_KIND,
  scanBlogEntries,
  sectionResolveTypes,
  setPostStatus,
  slugifyTitle,
  str,
  toArray,
  uniqueCategorySlug,
  uniquePostSlug,
  uniqueSlug,
  WRAPPER_KEY,
} from "@decocms/shared/blog";
import {
  CAMPAIGN_GOAL_METRICS,
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TARGET_KINDS,
  CAMPAIGN_TRIGGERS,
  MAX_CAMPAIGN_PRODUCT_IMAGES,
  type CampaignGoalMetric,
  type CampaignObjective,
  type CampaignStatus,
  type CampaignTargetKind,
  type CampaignTrigger,
} from "@decocms/shared/blog-campaign";
import type { TFunction, TranslationKey } from "@/i18n/use-t.ts";

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
  CAMPAIGN_GOAL_METRICS,
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_STATUSES,
  CAMPAIGN_TARGET_KINDS,
  CAMPAIGN_TRIGGERS,
  MAX_CAMPAIGN_PRODUCT_IMAGES,
  type CampaignGoalMetric,
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

/** What a campaign is for, in a figure someone can check by its period's end. */
export interface CampaignGoal {
  /** The goal in the brand's words; "" when the campaign has none. */
  text: string;
  /** What counts it; null until someone picks it. */
  metric: CampaignGoalMetric | null;
  /** How far, as typed: "+20%". */
  target: string;
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
  goal: CampaignGoal;
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
 * `campaignName` rather than `name`: the file is the key, so it is not stored.
 */
export function buildCampaignBlock(
  campaign: Omit<CampaignEntry, "key">,
): Record<string, unknown> {
  return {
    campaignName: campaign.name,
    seedKey: campaign.seedKey,
    status: campaign.status,
    period: {
      start: campaign.period.start ?? "",
      end: campaign.period.end ?? "",
    },
    trigger: { type: campaign.trigger.type, note: campaign.trigger.note },
    goal: {
      text: campaign.goal.text,
      metric: campaign.goal.metric,
      target: campaign.goal.target,
    },
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
    const goal = asRecord(record.goal) ?? {};
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
      goal: {
        text: str(goal.text),
        metric: CAMPAIGN_GOAL_METRICS.find((m) => m === goal.metric) ?? null,
        target: str(goal.target),
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

/** A campaign with no goal yet: what one reads as before anyone sets it. */
export const NO_GOAL: CampaignGoal = { text: "", metric: null, target: "" };

/** A campaign as it is born: empty, in draft, nothing pinned. */
export function emptyCampaign(now: Date): Omit<CampaignEntry, "key"> {
  const stamp = now.toISOString();
  return {
    name: "",
    seedKey: "",
    status: "draft",
    period: { start: null, end: null },
    trigger: { type: "seasonal", note: "" },
    goal: { ...NO_GOAL },
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
  seed: Omit<CampaignSeedEntry, "key">,
): Record<string, unknown> {
  return {
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

/** Every record of `kind` with its RAW name — an "Untitled" fallback would read as a collision. */
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
  // Both post forms count: a planning draft carries no `__resolveType`.
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

/** Re-exported so this module's thirty-odd callers keep one import. */
export {
  type AuthorRef,
  blockComponentName,
  blockExample,
  blocksForFormat,
  BLOG_KINDS,
  BLOG_SINGULAR,
  type BlogBlockDiscoveryOptions,
  type BlogBlockSource,
  type BlogBlockType,
  blogBlockTypeFor,
  type BlogEntry,
  type BlogKind,
  type BrandRule,
  buildBlogBlock,
  buildGeneratedPostPayload,
  buildPostSections,
  type CategoryRef,
  citedSections,
  DEFAULT_SCHEDULE_HOUR,
  defaultScheduledDatetime,
  discoverBlogBlockTypes,
  FORMATS_BLOCK_KEY,
  type GenerationBlock,
  getBlogPayload,
  isBlogKind,
  isBlogPostBlockResolveType,
  KNOWN_BLOG_BLOCK_EXAMPLES,
  listAuthorRefs,
  listBlogPayloads,
  livePostKey,
  maskSlugInput,
  missingCategoryFields,
  type MissingFieldKey,
  missingPostFields,
  newPostId,
  PLANNING_POST_KEY_PREFIX,
  type PlanningMeta,
  planningPostKey,
  POST_STATUSES,
  postIdOfKey,
  type PostStatus,
  postStatus,
  productSlotOf,
  rawBlockSchema,
  reconciledSchema,
  RESOLVE_TYPE_FOR_KIND,
  scanBlogEntries,
  sectionResolveTypes,
  setPostStatus,
  slugifyTitle,
  uniqueCategorySlug,
  uniquePostSlug,
  uniqueSlug,
  WRAPPER_KEY,
};
