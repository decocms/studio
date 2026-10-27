/**
 * The Content tab of a hosted Blocks v8 site, as content types: every saved
 * block is filed under its type (the schema's manifest key, aliases folded
 * into their target) and each type under the manifest group it belongs to,
 * so the sidebar lists only the types the site HAS content of, never the
 * whole block map. Each entry carries its status in the draft, from the
 * draft's changes (`changes.list`): published, changed, new, or deleted (a
 * deletion's content is the published copy, from `changes.get`'s `before`).
 *
 * Pure: reads the blocks, the schema and the changes the editor already
 * holds, no request of its own.
 */

import { type Change, spellingKey } from "@decocms/blocks/protocol";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { namedRuleKindOfType } from "@/components/sections-editor/named-rules";
import { normalizePagePath } from "@/components/sections-editor/page-path-utils";
import { getPageVariantSectionsAt } from "@/components/sections-editor/page-variants";
import { underlyingSectionResolveType } from "@/components/sections-editor/section-catalog";
import { getRedirectPayload, type RedirectType } from "./redirect-data";

export type EntryStatus = "published" | "changed" | "new" | "deleted";

/** The schema's manifest groups (`schema.gen.json` → `manifest.blocks`). */
export type ManifestGroup =
  | "pages"
  | "redirects"
  | "sections"
  | "loaders"
  | "matchers"
  | "content"
  | "other";

export interface ContentEntry {
  /** The block's name in the content (its key). */
  key: string;
  /** The block as the draft holds it; a deleted one's published copy. */
  block: Record<string, unknown>;
  status: EntryStatus;
}

export interface ContentType {
  /** The manifest key, aliases folded (`page`, `site-header`, …). */
  id: string;
  group: ManifestGroup;
  title: string;
  /** Loaders: the app the type belongs to ("Shopify"); `""`: the site's own. */
  app?: string;
  entries: ContentEntry[];
  /** Entries with a change in the draft (any status but published). */
  changed: number;
}

export interface AppGroup {
  /** The app's name; `""` for the site's own data loaders. */
  label: string;
  types: ContentType[];
}

export interface ContentTypeTree {
  pages: ContentType | null;
  redirects: ContentType | null;
  /** Section and content types with exactly one entry (Header, Settings). */
  everywhere: ContentType[];
  /** Other section types, most entries first. */
  sections: ContentType[];
  apps: AppGroup[];
  rules: ContentType[];
  /** Types the schema doesn't declare (the editor still opens them). */
  other: ContentType[];
  /** Every type above, for lookups by id. */
  all: ContentType[];
  /** Entries with a change in the draft, across every type. */
  changed: Array<{ type: ContentType; entry: ContentEntry }>;
}

/** How many section types the sidebar shows before "Show all". */
export const TOP_SECTION_TYPES = 5;

/** Built-ins whose schema title is their raw key get Studio's names. */
const BUILT_IN_TITLES: Record<string, string> = {
  page: "Pages",
  redirect: "Redirects",
  "cms-settings": "Settings",
};

const KNOWN_GROUPS: ReadonlySet<string> = new Set([
  "pages",
  "redirects",
  "sections",
  "loaders",
  "matchers",
  "content",
]);

/** Types that only wrap another block: filed under what they wrap. */
const WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "lazy",
  "multivariate",
  "website/flags/multivariate.ts",
  "website/flags/multivariate/section.ts",
]);

/** How deep a saved block may point at another before we give up. */
const MAX_REF_HOPS = 8;

type Manifest = Record<
  string,
  Record<string, { $ref?: string; namespace?: string }>
>;

function manifestOf(meta: LiveMeta | null | undefined): Manifest {
  return (meta?.manifest?.blocks ?? {}) as Manifest;
}

function aliasesOf(meta: LiveMeta | null | undefined): Record<string, string> {
  const aliases = (meta as { aliases?: unknown } | null | undefined)?.aliases;
  return aliases && typeof aliases === "object"
    ? (aliases as Record<string, string>)
    : {};
}

/** A manifest key with its alias followed (`website/pages/Page.tsx` → `page`). */
export function aliasTarget(
  meta: LiveMeta | null | undefined,
  key: string,
): string {
  const target = aliasesOf(meta)[key];
  return typeof target === "string" && target ? target : key;
}

function manifestEntry(meta: LiveMeta | null | undefined, key: string) {
  for (const [group, entries] of Object.entries(manifestOf(meta))) {
    if (entries && Object.hasOwn(entries, key)) {
      return { group, entry: entries[key] ?? {} };
    }
  }
  return null;
}

/** The manifest group that declares `key` (after its alias), if any. */
export function manifestGroupOf(
  meta: LiveMeta | null | undefined,
  key: string,
): ManifestGroup | null {
  const found = manifestEntry(meta, aliasTarget(meta, key));
  if (!found) return null;
  return KNOWN_GROUPS.has(found.group)
    ? (found.group as ManifestGroup)
    : "other";
}

/**
 * The type a saved block is filed under: its `__resolveType` with the alias
 * followed, through any saved block it points at (a block typed `Header`
 * is a copy of the saved `Header`), and through a variants wrapper to the
 * section it wraps. `null` for a block with no type.
 */
export function typeOfBlock(
  meta: LiveMeta | null | undefined,
  blocks: Record<string, unknown>,
  block: Record<string, unknown>,
): string | null {
  let current: Record<string, unknown> = block;
  for (let hop = 0; hop < MAX_REF_HOPS; hop++) {
    const rt = current.__resolveType;
    if (typeof rt !== "string" || !rt) return null;
    const type = aliasTarget(meta, rt);
    if (manifestEntry(meta, type)) {
      if (!WRAPPER_TYPES.has(type) || !meta) return type;
      const inner = underlyingSectionResolveType(meta, current);
      return inner && inner !== rt ? aliasTarget(meta, inner) : type;
    }
    const saved = blocks[rt];
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
      return type;
    }
    current = saved as Record<string, unknown>;
  }
  return null;
}

/**
 * "Product Shelf" from `site/sections/Product/ProductShelf.tsx`,
 * `product-shelf` or `productShelf`: the last path segment, without its
 * extension, split into words.
 */
export function humanizeTypeKey(key: string): string {
  const last = key.split("/").filter(Boolean).pop() ?? key;
  const words = last
    .replace(/\.(tsx?|jsx?|html?)$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_\s]+/g, " ")
    .trim();
  if (!words) return key;
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

function definitionTitle(
  meta: LiveMeta | null | undefined,
  key: string,
): string | null {
  const ref = manifestEntry(meta, key)?.entry.$ref;
  if (typeof ref !== "string") return null;
  const id = ref.split("/").pop() ?? "";
  const definitions = (meta?.schema as { definitions?: unknown } | undefined)
    ?.definitions as Record<string, { title?: unknown }> | undefined;
  const title = definitions?.[id]?.title;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

/**
 * A type's name for people: Studio's name for a built-in, the schema
 * definition's title, or the key humanized when the title is the raw key
 * (or path-like) or missing.
 */
export function typeTitle(
  meta: LiveMeta | null | undefined,
  key: string,
): string {
  const type = aliasTarget(meta, key);
  const builtIn = BUILT_IN_TITLES[type];
  if (builtIn) return builtIn;
  const title = definitionTitle(meta, type);
  if (title && title !== type && !title.includes("/")) return title;
  return humanizeTypeKey(type);
}

/** An entry's status from its change in the draft (none: published). */
export function entryStatus(change: Change | undefined): EntryStatus {
  if (!change) return "published";
  if (change.kind === "delete") return "deleted";
  return change.baseVersion === null ? "new" : "changed";
}

/** The draft's changes by spelling (a block's name may be spelled two ways). */
function changesBySpelling(
  changes: Record<string, Change> | null | undefined,
): Map<string, { name: string; change: Change }> {
  const out = new Map<string, { name: string; change: Change }>();
  for (const [name, change] of Object.entries(changes ?? {})) {
    out.set(spellingKey(name), { name, change });
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The app a loader type belongs to: its namespace, or for the site's own
 * loaders the vendor word several of them start with ("Shopify Product
 * List" → Shopify), else `""`: the site's own data. Also returns the title
 * without the vendor word.
 */
function loaderApp(
  meta: LiveMeta | null | undefined,
  key: string,
  title: string,
  sharedPrefixes: ReadonlySet<string>,
): { app: string; title: string } {
  const namespace = manifestEntry(meta, key)?.entry.namespace;
  if (namespace && namespace !== "site" && namespace !== "deco") {
    return { app: humanizeTypeKey(namespace), title };
  }
  const [first, ...rest] = title.split(" ");
  if (first && rest.length > 0 && sharedPrefixes.has(first.toLowerCase())) {
    return { app: first, title: rest.join(" ") };
  }
  return { app: "", title };
}

/** First words two or more loader titles share (vendor prefixes). */
function sharedFirstWords(titles: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const title of titles) {
    const [first, ...rest] = title.split(" ");
    if (!first || rest.length === 0) continue;
    const word = first.toLowerCase();
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([w]) => w));
}

/**
 * Every saved block filed under its type and group. `deleted` holds the
 * published copy of each block the draft deletes, by name (from
 * `changes.get`), so a deleted entry still shows under its type; without it
 * a deletion is listed only in the draft's changes.
 */
export function buildContentTypes(input: {
  blocks: Record<string, unknown>;
  meta: LiveMeta | null | undefined;
  changes: Record<string, Change> | null | undefined;
  deleted?: Record<string, Record<string, unknown> | null> | null;
}): ContentTypeTree {
  const { blocks, meta } = input;
  const bySpelling = changesBySpelling(input.changes);
  const byType = new Map<string, ContentEntry[]>();
  const add = (type: string, entry: ContentEntry) => {
    const list = byType.get(type);
    if (list) list.push(entry);
    else byType.set(type, [entry]);
  };
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(blocks)) {
    if (!isRecord(value)) continue;
    const type = typeOfBlock(meta, blocks, value);
    if (!type) continue;
    const spelling = spellingKey(key);
    seen.add(spelling);
    add(type, {
      key,
      block: value,
      status: entryStatus(bySpelling.get(spelling)?.change),
    });
  }
  // Deletions: the draft no longer has them, the published copy says what
  // they were.
  for (const [spelling, { name, change }] of bySpelling) {
    if (change.kind !== "delete" || seen.has(spelling)) continue;
    const before = input.deleted?.[name];
    if (!isRecord(before)) continue;
    const type = typeOfBlock(meta, blocks, before);
    if (!type) continue;
    add(type, { key: name, block: before, status: "deleted" });
  }

  const loaderTitles = [...byType.keys()]
    .filter((type) => manifestGroupOf(meta, type) === "loaders")
    .map((type) => typeTitle(meta, type));
  const prefixes = sharedFirstWords(loaderTitles);

  const all: ContentType[] = [];
  for (const [id, entries] of byType) {
    // The named rules (tests, campaigns) keep their own views.
    if (namedRuleKindOfType(id)) continue;
    if (WRAPPER_TYPES.has(id)) continue;
    const group = manifestGroupOf(meta, id) ?? "other";
    let title = typeTitle(meta, id);
    let app: string | undefined;
    if (group === "loaders") {
      ({ app, title } = loaderApp(meta, id, title, prefixes));
    }
    // What the draft adds first (what was just made), then by name.
    entries.sort(
      (a, b) =>
        Number(b.status === "new") - Number(a.status === "new") ||
        entryName(a).localeCompare(entryName(b)),
    );
    all.push({
      id,
      group,
      title,
      ...(app !== undefined ? { app } : {}),
      entries,
      changed: entries.filter((e) => e.status !== "published").length,
    });
  }
  all.sort((a, b) => a.title.localeCompare(b.title));

  const of = (group: ManifestGroup) => all.filter((t) => t.group === group);
  const singleton = (t: ContentType) => t.entries.length === 1;
  const sectionTypes = of("sections");
  const contentTypes = of("content");
  const everywhere = [...sectionTypes, ...contentTypes]
    .filter(singleton)
    .sort((a, b) => a.title.localeCompare(b.title));
  const sections = sectionTypes
    .filter((t) => !singleton(t))
    .sort(
      (a, b) =>
        b.entries.length - a.entries.length || a.title.localeCompare(b.title),
    );
  const appsByLabel = new Map<string, ContentType[]>();
  for (const type of of("loaders")) {
    const label = type.app ?? "";
    appsByLabel.set(label, [...(appsByLabel.get(label) ?? []), type]);
  }
  const apps = [...appsByLabel]
    .map(([label, types]) => ({ label, types }))
    // The site's own data last.
    .sort((a, b) =>
      !a.label || !b.label
        ? Number(!a.label) - Number(!b.label)
        : a.label.localeCompare(b.label),
    );
  const pages = of("pages")[0] ?? null;
  const redirects = of("redirects")[0] ?? null;
  const other = [
    ...contentTypes.filter((t) => !singleton(t)),
    ...of("pages").slice(1),
    ...of("redirects").slice(1),
    ...of("other"),
  ];

  const changed: ContentTypeTree["changed"] = [];
  for (const type of all) {
    for (const entry of type.entries) {
      if (entry.status !== "published") changed.push({ type, entry });
    }
  }
  return {
    pages,
    redirects,
    everywhere,
    sections,
    apps,
    rules: of("matchers"),
    other,
    all,
    changed,
  };
}

/** The section types the sidebar shows: the top few, or all of them. */
export function visibleSectionTypes(
  sections: ContentType[],
  showAll: boolean,
): { shown: ContentType[]; hidden: number } {
  if (showAll || sections.length <= TOP_SECTION_TYPES) {
    return { shown: sections, hidden: 0 };
  }
  return {
    shown: sections.slice(0, TOP_SECTION_TYPES),
    hidden: sections.length - TOP_SECTION_TYPES,
  };
}

/** Whether an app group starts collapsed: when it lists many types. */
export function appGroupCollapsedByDefault(group: AppGroup): boolean {
  return group.types.length > 3;
}

function decodeName(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

/**
 * An entry's name for people: its own `name` field, a redirect's source
 * path, else its key.
 */
export function entryName(entry: ContentEntry): string {
  const nested = entry.block.redirect;
  const candidates = [
    entry.block.name,
    entry.block.from,
    isRecord(nested) ? nested.from : undefined,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return decodeName(entry.key);
}

/** A page's path, as saved. */
export function pagePathOf(entry: ContentEntry): string {
  return typeof entry.block.path === "string" ? entry.block.path : "";
}

/** How many sections a page shows (its first variant's, when it has variants). */
export function pageSectionCount(entry: ContentEntry): number {
  return getPageVariantSectionsAt({ [entry.key]: entry.block }, entry.key, 0)
    .length;
}

/** Whether a page route (`/collections/:handle`, `/*`) matches `path`. */
export function routeMatches(route: string, path: string): boolean {
  const r = normalizePagePath(route).split("/").filter(Boolean);
  const p = normalizePagePath(path.split(/[?#]/)[0] ?? "")
    .split("/")
    .filter(Boolean);
  for (let i = 0; i < r.length; i++) {
    const seg = r[i] ?? "";
    if (seg === "*" || seg.startsWith("*")) return true;
    if (i >= p.length) return false;
    if (seg.startsWith(":")) continue;
    if (seg !== p[i]) return false;
  }
  return r.length === p.length;
}

/**
 * The page a redirect sends visitors to: the one whose path is the
 * destination, else the first whose route matches it (a catch-all last).
 */
export function redirectDestinationPage(
  pages: ContentEntry[],
  to: string,
): ContentEntry | null {
  if (!to.startsWith("/")) return null;
  const live = pages.filter((p) => p.status !== "deleted");
  const exact = live.find(
    (p) => normalizePagePath(pagePathOf(p)) === normalizePagePath(to),
  );
  if (exact) return exact;
  const matching = live.filter((p) => routeMatches(pagePathOf(p), to));
  return (
    matching.find((p) => !pagePathOf(p).includes("*")) ?? matching[0] ?? null
  );
}

export interface RedirectRow {
  from: string;
  to: string;
  kind: RedirectType;
}

export function redirectRowOf(entry: ContentEntry): RedirectRow {
  const payload = getRedirectPayload(entry.block);
  return { from: payload.from, to: payload.to, kind: payload.type };
}

/** Field names worth a column, best first. */
const SUMMARY_FIELDS = [
  "title",
  "headline",
  "heading",
  "label",
  "subtitle",
  "text",
  "description",
  "href",
  "url",
];

/**
 * The one or two fields that say most about a type's entries: the first of
 * {@link SUMMARY_FIELDS} its entries hold as text, then the next.
 */
export function summaryFieldsOf(type: ContentType): string[] {
  const holds = (field: string) =>
    type.entries.some((e) => {
      const value = e.block[field];
      return typeof value === "string" && value.trim() !== "";
    });
  return SUMMARY_FIELDS.filter((f) => f !== "name" && holds(f)).slice(0, 2);
}

/** A summary field's value, as one line of text. */
export function summaryValue(entry: ContentEntry, field: string): string {
  const value = entry.block[field];
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** Whether `query` finds an entry (its name, key, path or summary fields). */
export function entryMatches(
  entry: ContentEntry,
  query: string,
  fields: readonly string[] = [],
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    entryName(entry),
    entry.key,
    pagePathOf(entry),
    // A redirect's paths, flat or nested.
    ...(isRecord(entry.block.redirect) || typeof entry.block.to === "string"
      ? [redirectRowOf(entry).from, redirectRowOf(entry).to]
      : []),
    ...fields.map((f) => summaryValue(entry, f)),
  ];
  return hay.some((s) => s.toLowerCase().includes(q));
}
