import type { BoundObjectStorage } from "@/object-storage/bound-object-storage";
import {
  DESIGN_SYSTEM_DEMO_HTML,
  DESIGN_SYSTEM_DEMO_JS,
  DESIGN_SYSTEM_TOKENS_CSS,
  PAGE_TEMPLATE_APP_JS,
  PAGE_TEMPLATE_INDEX_HTML,
  PAGE_TEMPLATE_PAGE_JS,
  PAGE_TEMPLATE_SECTIONS_JS,
  type BrandTokens,
  renderTemplate,
} from "./templates";
import {
  enforceContrast,
  ensureSurfaceDistinct,
  parseHex,
  pickReadableText,
} from "./contrast";
import { getDefaultTheme } from "./default-themes";

/* ---------------------------------------------------------------------------
 * Object-storage key layout (per-org bucket, prefix-scoped).
 *
 * The BoundObjectStorage passed in by callers is org-bound at construction,
 * so we never carry orgId in keys here — it's baked into the binding.
 *
 *   page-preview/state.json
 *   page-preview/pages/<slug>/{index.html, app.js, sections.js, page.js, meta.json}
 *   page-preview/design-systems/<slug>/{demo.html, demo.js, tokens.css, tokens.js, meta.json}
 * ------------------------------------------------------------------------- */
const KEY_PREFIX = "page-preview";
const STATE_KEY = `${KEY_PREFIX}/state.json`;
const PAGES_PREFIX = `${KEY_PREFIX}/pages`;
const DESIGN_SYSTEMS_PREFIX = `${KEY_PREFIX}/design-systems`;
const PAGE_META_FILE = "meta.json";
const DESIGN_SYSTEM_META_FILE = "meta.json";

function pageObjKey(slug: string, file: string): string {
  return `${PAGES_PREFIX}/${slug}/${file}`;
}
function dsObjKey(slug: string, file: string): string {
  return `${DESIGN_SYSTEMS_PREFIX}/${slug}/${file}`;
}

export type PreviewKind = "page" | "design-system";

export interface PagePreviewPage {
  slug: string;
  name: string;
  designSystem: string | null;
  path: string;
  relativePath: string;
  url: string;
  lastModified: string;
}

export interface DesignSystemEntry {
  slug: string;
  name: string;
  brand: BrandTokens;
  path: string;
  relativePath: string;
  url: string;
  lastModified: string;
}

export interface PagePreviewStatus {
  pagesDir: string;
  activeKind: PreviewKind | null;
  activePath: string | null;
  activeRelativePath: string | null;
  activeUrl: string | null;
  activeDesignSystem: string | null;
  refreshVersion: number;
  pages: PagePreviewPage[];
  designSystems: DesignSystemEntry[];
  /** Current in-flight agent step label (cleared by scaffold tool results). */
  progressLabel: string | null;
  progressUpdatedAt: string | null;
  /**
   * Latest agent-declared section outline ("Nav · Hero · Features · …").
   * Cleared alongside the active page (e.g. by PAGE_PREVIEW_SET that lands a
   * different page) but NOT cleared by individual PROGRESS / REFRESH calls —
   * the stepper should persist throughout the build of a single page.
   */
  outline: string[] | null;
  outlineUpdatedAt: string | null;
}

interface PagePreviewState {
  activeKind: PreviewKind | null;
  activePath: string | null;
  activeDesignSystem: string | null;
  refreshVersion: number;
  updatedAt: string | null;
  /** Latest in-flight agent step label, e.g. "Picking a design system…". */
  progressLabel: string | null;
  /** ISO timestamp when progressLabel was set — used to age stale labels. */
  progressUpdatedAt: string | null;
  /** Agent-declared section outline (mini-TOC stepper input). */
  outline: string[] | null;
  outlineUpdatedAt: string | null;
}

export interface PagePreviewOptions {
  /** Identifier used for in-memory keying (live block store, etc.). */
  orgId: string;
  /** Org-bound storage binding — the orgId is baked into this. */
  objectStorage: BoundObjectStorage;
  orgSlug?: string | null;
  baseUrl?: string | null;
}

export interface PagePreviewSetOptions extends PagePreviewOptions {
  path: string;
}

export interface DesignSystemCreateOptions extends PagePreviewOptions {
  slug: string;
  name?: string;
  /** When set, the brand tokens are seeded from the matching DEFAULT_THEMES
   *  entry. Any fields the caller supplies in `brand` override the template.
   *  Lets the agent commit a complete, contrast-safe palette in one shot
   *  by naming a curated theme instead of inventing twelve hex values. */
  template?: string;
  brand: BrandTokens;
}

export interface PageCreateOptions extends PagePreviewOptions {
  slug: string;
  name?: string;
  designSystem: string;
  title?: string;
  description?: string;
  /**
   * Whether to switch the preview pane to the new page immediately. Default
   * is `false` — the design system stays visible until the agent edits
   * page.js to add the first real section, then calls PAGE_PREVIEW_SET to
   * promote the page. This avoids the user seeing a blank/scaffolded page
   * for the seconds between creation and the first section.
   */
  activate?: boolean;
}

/* ---------------------------------------------------------------------------
 * Object-storage I/O primitives. All page-preview persistence flows through
 * these — never raw fs. The binding is org-scoped at construction.
 * ------------------------------------------------------------------------- */

async function readJsonObject<T>(
  storage: BoundObjectStorage,
  key: string,
): Promise<T | null> {
  try {
    const res = await storage.get(key);
    if ("error" in res) return null;
    return JSON.parse(res.content) as T;
  } catch {
    return null;
  }
}

async function writeJsonObject(
  storage: BoundObjectStorage,
  key: string,
  value: unknown,
): Promise<void> {
  await storage.put(key, `${JSON.stringify(value, null, 2)}\n`, {
    contentType: "application/json",
  });
}

async function readTextObject(
  storage: BoundObjectStorage,
  key: string,
): Promise<string | null> {
  try {
    const res = await storage.get(key);
    if ("error" in res) return null;
    return res.content;
  } catch {
    return null;
  }
}

async function writeTextObject(
  storage: BoundObjectStorage,
  key: string,
  content: string,
  contentType: string,
): Promise<void> {
  await storage.put(key, content, { contentType });
}

interface ObjectHead {
  size: number;
  lastModified?: Date;
}

async function statObject(
  storage: BoundObjectStorage,
  key: string,
): Promise<ObjectHead | null> {
  try {
    return await storage.head(key);
  } catch {
    return null;
  }
}

/**
 * List immediate sub-slugs under a prefix using `delimiter: "/"`. Returns
 * the slug names (the directory-like commonPrefixes with the trailing slash
 * stripped). Mirrors what `readdir({withFileTypes}).filter(isDirectory)`
 * gave us in the disk era.
 */
async function listSlugs(
  storage: BoundObjectStorage,
  prefix: string,
): Promise<string[]> {
  const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const result = await storage.list({
    prefix: normalized,
    delimiter: "/",
    maxKeys: 1000,
  });
  // S3 and DevObjectStorage agree on the format mostly, but DevObjectStorage
  // emits `prefix//slug/` (double slash) when prefix already ends with "/".
  // Normalize: strip the matching prefix (with or without trailing slash),
  // drop the trailing slash, then drop any leftover leading slash.
  const base = normalized.replace(/\/$/, "");
  return (result.commonPrefixes ?? [])
    .map((p) => {
      let slug = p.startsWith(normalized)
        ? p.slice(normalized.length)
        : p.startsWith(base)
          ? p.slice(base.length)
          : p;
      slug = slug.replace(/^\/+/, "").replace(/\/+$/, "");
      return slug;
    })
    .filter((s) => s.length > 0 && !s.includes("/"));
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Reject URL strings that could execute script. The agent supplies free-form
 * href/src values in block props; without a scheme allow-list a malicious
 * (or compromised) agent could land a `javascript:` URL that fires on click.
 * Anything outside the safe set collapses to "#".
 */
function safeUrl(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return value;
  // Relative URLs (no scheme) and hash anchors are always safe.
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return value;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return value; // no scheme
  const lowered = trimmed.toLowerCase();
  if (
    lowered.startsWith("http://") ||
    lowered.startsWith("https://") ||
    lowered.startsWith("mailto:") ||
    lowered.startsWith("tel:")
  ) {
    return value;
  }
  return "#";
}

const URL_PROP_KEY = /^(?:href|src|.*Href|.*Src)$/i;

/**
 * Walk a block-props object and replace any href/src/-Href/-Src value that
 * uses an unsafe URL scheme. Idempotent; structure preserved.
 */
export function sanitizeBlockProps(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = URL_PROP_KEY.test(k) ? safeUrl(v) : visit(v);
      }
      return out;
    }
    return value;
  };
  return visit(input) as Record<string, unknown>;
}

/**
 * Per-org serialization for state read-modify-write cycles. Two
 * concurrent tool calls in the same chat turn (e.g. PAGE_BOOTSTRAP and
 * PAGE_PREVIEW_PROGRESS) used to race on the singleton state.json:
 * both would read the same baseline, modify independently, and the
 * second writer would silently overwrite the first. We serialize all
 * mutations through a per-org promise chain so the second writer
 * always sees the first writer's result. This is in-process only —
 * a multi-pod deployment still relies on object-storage put being
 * atomic per key, which it is.
 */
const stateMutex = new Map<string, Promise<void>>();

async function withStateLock<T>(
  orgId: string,
  body: () => Promise<T>,
): Promise<T> {
  const prev = stateMutex.get(orgId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  stateMutex.set(
    orgId,
    prev.then(() => next),
  );
  await prev;
  try {
    return await body();
  } finally {
    release();
    // If the chain we just released is the latest one, drop the entry so
    // long-lived processes don't accumulate completed-promise references.
    if (stateMutex.get(orgId) === prev.then(() => next)) {
      stateMutex.delete(orgId);
    }
  }
}

async function readState(
  storage: BoundObjectStorage,
): Promise<PagePreviewState> {
  const parsed =
    (await readJsonObject<Partial<PagePreviewState>>(storage, STATE_KEY)) ?? {};
  const kind =
    parsed.activeKind === "page" || parsed.activeKind === "design-system"
      ? parsed.activeKind
      : null;
  return {
    activeKind: kind,
    activePath:
      typeof parsed.activePath === "string" ? parsed.activePath : null,
    activeDesignSystem:
      typeof parsed.activeDesignSystem === "string"
        ? parsed.activeDesignSystem
        : null,
    refreshVersion:
      typeof parsed.refreshVersion === "number" &&
      Number.isFinite(parsed.refreshVersion)
        ? parsed.refreshVersion
        : 0,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    progressLabel:
      typeof parsed.progressLabel === "string" ? parsed.progressLabel : null,
    progressUpdatedAt:
      typeof parsed.progressUpdatedAt === "string"
        ? parsed.progressUpdatedAt
        : null,
    outline:
      Array.isArray(parsed.outline) &&
      parsed.outline.every((s) => typeof s === "string")
        ? (parsed.outline as string[])
        : null,
    outlineUpdatedAt:
      typeof parsed.outlineUpdatedAt === "string"
        ? parsed.outlineUpdatedAt
        : null,
  };
}

async function writeState(
  storage: BoundObjectStorage,
  state: PagePreviewState,
) {
  await writeJsonObject(storage, STATE_KEY, state);
}

function encodePath(relativePath: string): string {
  return relativePath.split("/").map(encodeURIComponent).join("/");
}

/**
 * Build a public URL for a page-preview asset via Studio's canonical
 * `/api/{org}/files/{key}` redirect — which already presigns and serves
 * the object via the same code path the rest of Studio uses.
 *
 * `relativePath` is the page-preview-scoped path, e.g.
 * "pages/<slug>/index.html". We prepend the `page-preview/` prefix so it
 * resolves to the actual storage key.
 */
function buildFileUrl(options: {
  baseUrl?: string | null;
  orgSlug?: string | null;
  relativePath: string;
  refreshVersion: number;
}): string {
  const orgSlug = options.orgSlug ?? "";
  const path = `/api/${encodeURIComponent(orgSlug)}/files/${KEY_PREFIX}/${encodePath(options.relativePath)}`;
  const url = options.baseUrl
    ? new URL(path, options.baseUrl)
    : new URL(path, "http://localhost");
  url.searchParams.set("v", String(options.refreshVersion));
  return options.baseUrl ? url.toString() : `${url.pathname}${url.search}`;
}

/* ---------------------------------------------------------------------------
 * Pages
 * ------------------------------------------------------------------------- */

interface PageMeta {
  name?: string;
  designSystem?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

async function loadPageMeta(
  storage: BoundObjectStorage,
  slug: string,
): Promise<PageMeta> {
  return (
    (await readJsonObject<PageMeta>(
      storage,
      pageObjKey(slug, PAGE_META_FILE),
    )) ?? {}
  );
}

export async function discoverHtmlPages(
  options: PagePreviewOptions,
): Promise<PagePreviewPage[]> {
  const { objectStorage } = options;
  const state = await readState(objectStorage);
  const slugs = await listSlugs(objectStorage, PAGES_PREFIX);
  const pages: PagePreviewPage[] = [];

  await Promise.all(
    slugs.map(async (slug) => {
      // Discover the first existing index.{html,htm} for this slug. Most
      // pages ship index.html; the .htm fallback is for legacy data.
      const candidates = ["index.html", "index.htm"];
      for (const file of candidates) {
        const head = await statObject(objectStorage, pageObjKey(slug, file));
        if (!head) continue;
        const meta = await loadPageMeta(objectStorage, slug);
        const relativePath = `pages/${slug}/${file}`;
        pages.push({
          slug,
          name: meta.name ?? slug,
          designSystem: meta.designSystem ?? null,
          path: pageObjKey(slug, file),
          relativePath,
          url: buildFileUrl({
            baseUrl: options.baseUrl,
            orgSlug: options.orgSlug,
            relativePath,
            refreshVersion: state.refreshVersion,
          }),
          lastModified: (head.lastModified ?? new Date()).toISOString(),
        });
        return;
      }
    }),
  );

  pages.sort(
    (a, b) =>
      new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime(),
  );
  return pages;
}

/* ---------------------------------------------------------------------------
 * Design Systems
 * ------------------------------------------------------------------------- */

interface DesignSystemMeta {
  name?: string;
  brand?: BrandTokens;
  createdAt?: string;
  updatedAt?: string;
}

async function discoverDesignSystems(
  options: PagePreviewOptions,
): Promise<DesignSystemEntry[]> {
  const { objectStorage } = options;
  const state = await readState(objectStorage);
  const slugs = await listSlugs(objectStorage, DESIGN_SYSTEMS_PREFIX);
  const out: DesignSystemEntry[] = [];

  await Promise.all(
    slugs.map(async (slug) => {
      const head = await statObject(objectStorage, dsObjKey(slug, "demo.html"));
      if (!head) return;
      const meta =
        (await readJsonObject<DesignSystemMeta>(
          objectStorage,
          dsObjKey(slug, DESIGN_SYSTEM_META_FILE),
        )) ?? {};
      const relativePath = `design-systems/${slug}/demo.html`;
      // DS stored before the `onPrimary`/`onSecondary`/`onAccent` tokens
      // were added may be missing them. Backfill via normalizeBrandContrast
      // (idempotent for already-complete brands).
      const sourceBrand = meta.brand ?? DEFAULT_BRAND;
      const brand = normalizeBrandContrast({
        ...DEFAULT_BRAND,
        ...sourceBrand,
      });
      out.push({
        slug,
        name: meta.name ?? slug,
        brand,
        path: dsObjKey(slug, "demo.html"),
        relativePath,
        url: buildFileUrl({
          baseUrl: options.baseUrl,
          orgSlug: options.orgSlug,
          relativePath,
          refreshVersion: state.refreshVersion,
        }),
        lastModified: (head.lastModified ?? new Date()).toISOString(),
      });
    }),
  );

  out.sort(
    (a, b) =>
      new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime(),
  );
  return out;
}

/**
 * Default brand floor — fully populated so createDesignSystem can rely on
 * a complete shape before merging template + caller overrides. The
 * `onPrimary` / `onSecondary` / `onAccent` defaults are overwritten by
 * `normalizeBrandContrast` on every real DS create; they exist here only
 * so the BrandTokens type stays sound for callers that build a brand
 * without the contrast pass.
 */
export const DEFAULT_BRAND: BrandTokens = {
  name: "Untitled",
  primary: "#6366F1",
  secondary: "#22D3EE",
  accent: "#F472B6",
  bg: "#0B0B12",
  surface: "#15151F",
  fg: "#F6F6F8",
  muted: "#A0A0B0",
  border: "#262633",
  onPrimary: "#FFFFFF",
  onSecondary: "#0A0A0F",
  onAccent: "#0A0A0F",
  headingFont: "Instrument Serif",
  bodyFont: "Inter",
  radius: "12px",
};

/* ---------------------------------------------------------------------------
 * Page path resolution
 * ------------------------------------------------------------------------- */

async function resolveExistingPagePath(
  options: PagePreviewSetOptions,
): Promise<{ key: string; relativePath: string }> {
  const { objectStorage } = options;
  const rawPath = options.path.trim();
  if (!rawPath) throw new Error("Missing page path");

  // Build a list of candidate object-storage keys to probe, in priority
  // order. The caller may pass:
  //   - "pricing"                              → slug shortcut
  //   - "pages/pricing/index.html"             → already a relative path
  //   - "pricing/index.html"                   → relative under pages/
  const candidates: string[] = [];
  const looksLikeSlug = !rawPath.includes("/") && !rawPath.includes(".");
  if (looksLikeSlug) {
    candidates.push(pageObjKey(rawPath, "index.html"));
  }
  // Strip leading "page-preview/" if the caller pre-prefixed it.
  let cleaned = rawPath.replace(/^\/+/, "");
  if (cleaned.startsWith(`${KEY_PREFIX}/`)) {
    cleaned = cleaned.slice(KEY_PREFIX.length + 1);
  }
  if (cleaned.startsWith("pages/")) {
    // Already includes the pages/ prefix.
    candidates.push(`${KEY_PREFIX}/${cleaned}`);
    // Allow "pages/<slug>" without index.html.
    if (!/\.html?$/i.test(cleaned)) {
      candidates.push(`${KEY_PREFIX}/${cleaned}/index.html`);
    }
  } else if (!looksLikeSlug) {
    // Bare relative path under pages/ — e.g. "pricing/index.html".
    candidates.push(`${PAGES_PREFIX}/${cleaned}`);
    if (!/\.html?$/i.test(cleaned)) {
      candidates.push(`${PAGES_PREFIX}/${cleaned}/index.html`);
    }
  }

  for (const key of candidates) {
    const head = await statObject(objectStorage, key);
    if (!head) continue;
    if (!/\.html?$/i.test(key)) {
      throw new Error("Page preview path must point to an HTML file");
    }
    const relativePath = key.startsWith(`${KEY_PREFIX}/`)
      ? key.slice(KEY_PREFIX.length + 1)
      : key;
    return { key, relativePath };
  }
  throw new Error("Page file not found");
}

/* ---------------------------------------------------------------------------
 * Active page bookkeeping
 * ------------------------------------------------------------------------- */

function activePageFromState(args: {
  state: PagePreviewState;
  pages: PagePreviewPage[];
}): PagePreviewPage | null {
  const newest = args.pages[0] ?? null;
  const stateUpdatedAt = args.state.updatedAt
    ? new Date(args.state.updatedAt).getTime()
    : 0;
  const newestUpdatedAt = newest
    ? new Date(newest.lastModified).getTime()
    : Number.NEGATIVE_INFINITY;

  // If a brand-new page lands after the state was last set, auto-switch
  // to it (so the agent's freshly-created page becomes the preview without
  // an explicit SET call).
  if (
    args.state.activeKind !== "design-system" &&
    newest &&
    newestUpdatedAt > stateUpdatedAt
  ) {
    return newest;
  }

  if (args.state.activeKind === "page" && args.state.activePath) {
    const activeRel = args.state.activePath;
    const page = args.pages.find((p) => p.relativePath === activeRel);
    if (page) return page;
  }
  return newest;
}

function activeDesignSystemFromState(args: {
  state: PagePreviewState;
  designSystems: DesignSystemEntry[];
}): DesignSystemEntry | null {
  if (args.state.activeKind !== "design-system") return null;
  if (!args.state.activeDesignSystem) return null;
  return (
    args.designSystems.find((d) => d.slug === args.state.activeDesignSystem) ??
    null
  );
}

export async function getPagePreviewStatus(
  options: PagePreviewOptions,
): Promise<PagePreviewStatus> {
  const { objectStorage } = options;
  const state = await readState(objectStorage);
  const [pages, designSystems] = await Promise.all([
    discoverHtmlPages(options),
    discoverDesignSystems(options),
  ]);
  const activePage = activePageFromState({ state, pages });
  const activeDs = activeDesignSystemFromState({ state, designSystems });

  // Determine the effective active item for the iframe
  let activeKind: PreviewKind | null = state.activeKind;
  let activeEntry: PagePreviewPage | DesignSystemEntry | null = null;
  if (activeKind === "design-system" && activeDs) {
    activeEntry = activeDs;
  } else if (activeKind === "page" && activePage) {
    activeEntry = activePage;
  } else if (activePage) {
    activeKind = "page";
    activeEntry = activePage;
  } else if (designSystems[0]) {
    activeKind = "design-system";
    activeEntry = designSystems[0];
  } else {
    activeKind = null;
  }

  return {
    // `pagesDir` is a legacy field name from the disk era; we keep the
    // key for response-shape stability but populate it with the storage
    // key prefix so callers that log/display it still get something
    // useful.
    pagesDir: KEY_PREFIX,
    activeKind,
    activePath: activeEntry?.path ?? null,
    activeRelativePath: activeEntry?.relativePath ?? null,
    activeUrl: activeEntry?.url ?? null,
    activeDesignSystem:
      activeKind === "design-system"
        ? ((activeEntry as DesignSystemEntry | null)?.slug ?? null)
        : ((activeEntry as PagePreviewPage | null)?.designSystem ?? null),
    refreshVersion: state.refreshVersion,
    pages,
    designSystems,
    progressLabel: state.progressLabel,
    progressUpdatedAt: state.progressUpdatedAt,
    outline: state.outline,
    outlineUpdatedAt: state.outlineUpdatedAt,
  };
}

export async function setPagePreviewActive(
  options: PagePreviewSetOptions,
): Promise<PagePreviewStatus> {
  const { objectStorage } = options;
  const page = await resolveExistingPagePath(options);
  await withStateLock(options.orgId, async () => {
    const current = await readState(objectStorage);
    await writeState(objectStorage, {
      activeKind: "page",
      activePath: page.relativePath,
      activeDesignSystem: current.activeDesignSystem,
      refreshVersion: current.refreshVersion + 1,
      updatedAt: new Date().toISOString(),
      progressLabel: null,
      progressUpdatedAt: null,
      outline: current.outline,
      outlineUpdatedAt: current.outlineUpdatedAt,
    });
  });
  return getPagePreviewStatus(options);
}

export async function setActiveDesignSystem(
  options: PagePreviewOptions & { slug: string },
): Promise<PagePreviewStatus> {
  const { objectStorage } = options;
  const demoHead = await statObject(
    objectStorage,
    dsObjKey(options.slug, "demo.html"),
  );
  if (!demoHead) {
    throw new Error(`Design system "${options.slug}" not found`);
  }
  await withStateLock(options.orgId, async () => {
    const current = await readState(objectStorage);
    await writeState(objectStorage, {
      activeKind: "design-system",
      activePath: current.activePath,
      activeDesignSystem: options.slug,
      refreshVersion: current.refreshVersion + 1,
      updatedAt: new Date().toISOString(),
      progressLabel: null,
      progressUpdatedAt: null,
      // Switching to the DS demo means we're between pages — drop the
      // outline so a stale stepper from a previous build doesn't linger
      // over the demo.
      outline: null,
      outlineUpdatedAt: null,
    });
  });
  return getPagePreviewStatus(options);
}

export async function refreshPagePreview(
  options: PagePreviewOptions,
): Promise<PagePreviewStatus> {
  const { objectStorage } = options;
  await withStateLock(options.orgId, async () => {
    const current = await readState(objectStorage);
    await writeState(objectStorage, {
      ...current,
      refreshVersion: current.refreshVersion + 1,
      updatedAt: new Date().toISOString(),
      progressLabel: null,
      progressUpdatedAt: null,
      // Refresh is an idempotent re-render of the current page — outline
      // is still relevant; preserve it (the spread above carries it).
    });
  });
  return getPagePreviewStatus(options);
}

/**
 * Record an in-flight agent progress label (e.g. "Picking a design system…").
 * Called by the PAGE_PREVIEW_PROGRESS tool between scaffold steps so the
 * preview pane can render a status overlay. Any subsequent scaffold tool
 * (CREATE / SET / REFRESH) clears the label.
 *
 * Optionally accepts an `outline` — an ordered list of human-readable
 * section labels for the page being built ("Nav", "Hero", "Features",
 * "Pricing", …). The host renders this as a sticky stepper at the top of
 * page mode so the user can see the full plan and where the build is up to.
 * Passing the outline once at the start of a build is enough; subsequent
 * PROGRESS calls without an outline leave the previous one in place.
 */
export async function setPageProgress(
  options: PagePreviewOptions & { label: string; outline?: string[] | null },
): Promise<PagePreviewStatus> {
  const { objectStorage } = options;
  const trimmed = options.label.trim().slice(0, 120);
  await withStateLock(options.orgId, async () => {
    const current = await readState(objectStorage);
    // Normalize outline: trim each item, drop empties, cap to 12 entries
    // so a runaway outline can't blow up the stepper layout. A `null` or
    // `undefined` outline argument means "no change" — preserve the
    // existing one.
    let nextOutline = current.outline;
    let nextOutlineUpdatedAt = current.outlineUpdatedAt;
    if (Array.isArray(options.outline)) {
      const cleaned = options.outline
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter((s) => s.length > 0)
        .slice(0, 12);
      nextOutline = cleaned.length > 0 ? cleaned : null;
      nextOutlineUpdatedAt = new Date().toISOString();
    }
    await writeState(objectStorage, {
      ...current,
      progressLabel: trimmed || null,
      progressUpdatedAt: new Date().toISOString(),
      outline: nextOutline,
      outlineUpdatedAt: nextOutlineUpdatedAt,
    });
  });
  return getPagePreviewStatus(options);
}

/* ---------------------------------------------------------------------------
 * Scaffolders
 * ------------------------------------------------------------------------- */

/**
 * Normalize a brand palette so the produced design system always reads.
 *
 * The agent is unreliable about contrast: it routinely sets `muted` to a
 * pastel close to `bg`, which makes body text and eyebrow labels invisible.
 * Rather than relying on prompt rules alone, we run every brand through a
 * contrast enforcement pass before writing tokens to disk.
 *
 *  - fg     ≥ 7:1 against bg (WCAG AAA — heading + body text)
 *  - muted  ≥ 5.5:1 against bg (still body text in many places — eyebrow
 *           labels, hero subtitle, captions; bumped above the strict AA
 *           floor of 4.5 because palettes that *just* clear AA still feel
 *           washed-out on most monitors)
 *  - border ≥ 1.5:1 against bg (subtle but visible divider)
 *  - surface visibly distinct from bg
 *
 * When a token fails its threshold we mix it toward `fg` until it passes
 * (and if `fg` itself fails, we anchor toward black or white). This
 * preserves the hue intent better than slamming the token to fg directly.
 */
function normalizeBrandContrast(brand: BrandTokens): BrandTokens {
  if (!parseHex(brand.bg)) return brand;
  const fg = enforceContrast(brand.fg, brand.bg, { minRatio: 7 });
  const muted = enforceContrast(brand.muted, brand.bg, {
    minRatio: 5.5,
    toward: fg,
  });
  const border = enforceContrast(brand.border, brand.bg, {
    minRatio: 1.5,
    toward: fg,
  });
  const surface = ensureSurfaceDistinct(brand.surface, brand.bg);
  // Derive "on-X" text tokens against each colored background so that text
  // rendered on top of brand-primary / brand-secondary / brand-accent is
  // always ≥4.5:1. The agent picks brand hues freely; we pick the matching
  // text color server-side instead of relying on the templates to know.
  // Candidates: fg first (preserves brand voice when it passes), then bg
  // (often legible when primary is the opposite end of the luminance
  // scale), then pure white/black as last resorts.
  const onCandidates = [fg, brand.bg, "#FFFFFF", "#0A0A0F"];
  const pick = (background: string) =>
    pickReadableText(background, { candidates: onCandidates, minRatio: 4.5 });
  return {
    ...brand,
    fg,
    muted,
    border,
    surface,
    onPrimary: pick(brand.primary),
    onSecondary: pick(brand.secondary),
    onAccent: pick(brand.accent),
  };
}

export async function createDesignSystem(
  options: DesignSystemCreateOptions,
): Promise<{ slug: string; status: PagePreviewStatus }> {
  const slug = slugify(options.slug);
  if (!slug) throw new Error("Invalid design system slug");
  const { objectStorage } = options;

  // Seed order (lowest → highest precedence):
  //   1. DEFAULT_BRAND — fallback floor
  //   2. DEFAULT_THEMES[template] — if the agent named a curated theme
  //   3. options.brand — caller's explicit overrides (typically just primary
  //      + name when riffing on a template, or full palette when freestyle)
  //
  // We then run normalizeBrandContrast over the merged result so the on-X
  // tokens get computed against the final primary/secondary/accent.
  const templateBrand = options.template
    ? (getDefaultTheme(options.template)?.brand ?? null)
    : null;
  const brand = normalizeBrandContrast({
    ...DEFAULT_BRAND,
    ...(templateBrand ?? {}),
    ...options.brand,
  });
  const now = new Date().toISOString();

  // tokens.js is generated programmatically so arbitrary characters in
  // brand values (quotes, font stacks, etc.) can never break the JS
  // module parse. A template + string interpolation produced subtle
  // SyntaxErrors that left the preview as a blank styled body.
  const tokensJsSource = `export const BRAND = ${JSON.stringify(brand, null, 2)};\n`;
  await Promise.all([
    writeTextObject(
      objectStorage,
      dsObjKey(slug, "tokens.css"),
      renderTemplate(DESIGN_SYSTEM_TOKENS_CSS, brand),
      "text/css; charset=utf-8",
    ),
    writeTextObject(
      objectStorage,
      dsObjKey(slug, "tokens.js"),
      tokensJsSource,
      "application/javascript; charset=utf-8",
    ),
    writeTextObject(
      objectStorage,
      dsObjKey(slug, "demo.html"),
      renderTemplate(DESIGN_SYSTEM_DEMO_HTML, brand, {
        DESIGN_SYSTEM_NAME: options.name ?? slug,
      }),
      "text/html; charset=utf-8",
    ),
    writeTextObject(
      objectStorage,
      dsObjKey(slug, "demo.js"),
      renderTemplate(DESIGN_SYSTEM_DEMO_JS, brand),
      "application/javascript; charset=utf-8",
    ),
    writeJsonObject(objectStorage, dsObjKey(slug, DESIGN_SYSTEM_META_FILE), {
      name: options.name ?? slug,
      brand,
      createdAt: now,
      updatedAt: now,
    }),
  ]);

  // Bump refresh + activate as design-system preview
  await withStateLock(options.orgId, async () => {
    const current = await readState(objectStorage);
    await writeState(objectStorage, {
      activeKind: "design-system",
      activePath: current.activePath,
      activeDesignSystem: slug,
      refreshVersion: current.refreshVersion + 1,
      updatedAt: now,
      progressLabel: null,
      progressUpdatedAt: null,
      // Preserve outline: the agent typically declares it on the very
      // first PROGRESS call (before DS create), and that plan applies
      // to the page about to be built on top of this DS. Resetting here
      // drops the stepper exactly when the user most needs to see
      // "we're 1 of 7 done".
      outline: current.outline,
      outlineUpdatedAt: current.outlineUpdatedAt,
    });
  });

  const status = await getPagePreviewStatus(options);
  return { slug, status };
}

export async function createPage(
  options: PageCreateOptions,
): Promise<{ slug: string; status: PagePreviewStatus }> {
  const slug = slugify(options.slug);
  if (!slug) throw new Error("Invalid page slug");
  const dsSlug = slugify(options.designSystem);
  if (!dsSlug) throw new Error("Invalid design system slug");

  const { objectStorage } = options;
  const dsExists = await statObject(
    objectStorage,
    dsObjKey(dsSlug, "demo.html"),
  );
  if (!dsExists) {
    throw new Error(`Design system "${dsSlug}" not found — create it first.`);
  }

  const dsMeta =
    (await readJsonObject<DesignSystemMeta>(
      objectStorage,
      dsObjKey(dsSlug, DESIGN_SYSTEM_META_FILE),
    )) ?? {};
  const brand = { ...DEFAULT_BRAND, ...(dsMeta.brand ?? {}) };

  const title = options.title ?? options.name ?? slug;
  const description =
    options.description ?? `${title} — built with Page Editor`;
  const tokensHref = `../../design-systems/${dsSlug}/tokens.css`;
  const tokensModule = `../../design-systems/${dsSlug}/tokens.js`;

  const vars = {
    PAGE_TITLE: title,
    PAGE_DESCRIPTION: description,
    PAGE_SLUG: slug,
    DESIGN_SYSTEM_SLUG: dsSlug,
    TOKENS_CSS_HREF: tokensHref,
    TOKENS_JS_MODULE: tokensModule,
  };

  const now = new Date().toISOString();
  await Promise.all([
    writeTextObject(
      objectStorage,
      pageObjKey(slug, "index.html"),
      renderTemplate(PAGE_TEMPLATE_INDEX_HTML, brand, vars),
      "text/html; charset=utf-8",
    ),
    writeTextObject(
      objectStorage,
      pageObjKey(slug, "app.js"),
      renderTemplate(PAGE_TEMPLATE_APP_JS, brand, vars),
      "application/javascript; charset=utf-8",
    ),
    writeTextObject(
      objectStorage,
      pageObjKey(slug, "sections.js"),
      renderTemplate(PAGE_TEMPLATE_SECTIONS_JS, brand, vars),
      "application/javascript; charset=utf-8",
    ),
    writeTextObject(
      objectStorage,
      pageObjKey(slug, "page.js"),
      renderTemplate(PAGE_TEMPLATE_PAGE_JS, brand, vars),
      "application/javascript; charset=utf-8",
    ),
    writeJsonObject(objectStorage, pageObjKey(slug, PAGE_META_FILE), {
      name: options.name ?? title,
      designSystem: dsSlug,
      createdAt: now,
      updatedAt: now,
    }),
  ]);

  // Reset the in-memory block list — a fresh scaffold should never inherit
  // blocks from a previous build with the same slug.
  resetBlocks({
    orgId: options.orgId,
    objectStorage: options.objectStorage,
    orgSlug: options.orgSlug,
    baseUrl: options.baseUrl,
    slug,
  });

  await withStateLock(options.orgId, async () => {
    const current = await readState(objectStorage);
    // Default behavior: leave the design-system preview in place. Only
    // flip the preview to the new page when the caller explicitly opts
    // in (or there is no other preview to keep). Keeps the user staring
    // at the beautiful DS demo while the agent assembles the first real
    // section.
    const shouldActivate =
      options.activate === true ||
      (current.activeKind !== "design-system" && current.activeKind !== "page");
    await writeState(objectStorage, {
      activeKind: shouldActivate ? "page" : current.activeKind,
      activePath: shouldActivate
        ? `pages/${slug}/index.html`
        : current.activePath,
      activeDesignSystem: shouldActivate ? dsSlug : current.activeDesignSystem,
      refreshVersion: current.refreshVersion + 1,
      updatedAt: now,
      progressLabel: null,
      progressUpdatedAt: null,
      // Preserve outline — the agent declared its plan ONCE on the first
      // PROGRESS call, and that plan is precisely for the page being
      // created here. Wiping it would erase the stepper at the exact
      // moment the user wants to follow along.
      outline: current.outline,
      outlineUpdatedAt: current.outlineUpdatedAt,
    });
  });

  const status = await getPagePreviewStatus(options);
  return { slug, status };
}

/* ---------------------------------------------------------------------------
 * Cleanup — called when a Page Editor vMCP is deleted so the org's
 * page-preview bucket prefix doesn't accumulate orphaned objects.
 * ------------------------------------------------------------------------- */

export async function cleanupPageEditorStorage(
  storage: BoundObjectStorage,
): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const result = await storage.list({
      prefix: `${KEY_PREFIX}/`,
      continuationToken,
      maxKeys: 1000,
    });
    await Promise.all(result.objects.map((o) => storage.delete(o.key)));
    continuationToken = result.isTruncated
      ? result.nextContinuationToken
      : undefined;
  } while (continuationToken);
}

/* ---------------------------------------------------------------------------
 * Listings (cheap, for tools)
 * ------------------------------------------------------------------------- */

export async function listDesignSystems(
  options: PagePreviewOptions,
): Promise<DesignSystemEntry[]> {
  return discoverDesignSystems(options);
}

/* ---------------------------------------------------------------------------
 * Self-contained export bundles
 *
 * The on-disk layout has cross-folder references (pages/<slug>/index.html
 * loads `../../design-systems/<slug>/tokens.css` and imports JS modules
 * via `./app.js`). That's fine in-Studio because we serve everything from
 * one origin — but it does not survive `unzip && open index.html`:
 *
 *  - The `../../design-systems/...` paths point outside the unzipped page
 *    folder.
 *  - Browsers refuse to load ES modules over `file://` for security
 *    reasons (CORS / same-origin checks treat each file as opaque).
 *
 * To make `index.html` double-clickable, the export inlines:
 *   - The design system's `tokens.css` as a `<style>` block.
 *   - `tokens.js`, `sections.js`, `page.js`, and `app.js` as one
 *     consolidated inline `<script type="module">` block.
 *
 * CDN imports (`preact`, `htm`) still load over HTTPS and work fine from
 * file://. The result is a single, self-contained HTML file.
 * ------------------------------------------------------------------------- */

/**
 * Strip every top-level ESM `import` statement from a chunk so the chunks
 * can be safely concatenated into a single inline module. The consolidated
 * module re-declares the bindings once at the top.
 *
 * Handles both single-quote and double-quote forms, with or without
 * trailing semicolons, and multi-line `import { a, b, c } from '…';`.
 */
function stripAllImports(source: string): string {
  return source.replace(
    /^[ \t]*import\s+[\s\S]*?from\s+['"][^'"]+['"]\s*;?[ \t]*\r?\n?/gm,
    "",
  );
}

/**
 * Strip the `const html = htm.bind(h)` line(s) that each chunk declares so
 * the consolidated module's single top-level binding wins.
 */
function stripHtmBindLine(source: string): string {
  return source.replace(
    /^[ \t]*const\s+html\s*=\s*htm\.bind\s*\(\s*h\s*\)\s*;?[ \t]*\r?\n?/gm,
    "",
  );
}

/**
 * Extract the names of every `export function <Name>` and
 * `export const <Name>` and `export class <Name>` from a chunk, so the
 * inline module can reconstruct the `import * as Foo` namespace as a
 * plain object literal after concatenation. Dedups while preserving order.
 */
function extractSectionExports(source: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re =
    /^\s*export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  for (const m of source.matchAll(re)) {
    const name = m[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * GEO (Generative Engine Optimization) artifacts
 *
 * Exported pages ship with three machine-readable artifacts that help AI
 * search engines (ChatGPT, Claude, Perplexity, Gemini, AI Overviews) cite
 * the page accurately:
 *
 *   1. JSON-LD @graph in <head>     — Organization + WebSite + WebPage +
 *      speakable (always) plus FAQPage when the page ships a FAQ block.
 *      Server-rendered into raw HTML because AI crawlers do not execute
 *      JavaScript (GPTBot, ClaudeBot, PerplexityBot all fetch-and-parse).
 *
 *   2. /llms.txt                    — the emerging convention for "what
 *      this site is, in a format an LLM can ingest in one read". Fewer
 *      than ~5% of sites ship one as of early 2026, so it's a real
 *      differentiator. Format: H1 + blockquote + section lists per the
 *      llms.txt spec (https://llmstxt.org).
 *
 *   3. /robots.txt                  — explicitly allow-lists AI crawlers
 *      (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, PerplexityBot,
 *      Amazonbot, Google-Extended, Bytespider, CCBot, Applebot-Extended,
 *      FacebookBot, Cohere-ai) so they don't get blocked by a wildcard.
 *
 * Inputs come straight from the exported page artifacts (tokens.js for
 * brand, page.js for blocks); no extra prompt or call to the agent is
 * required.
 * ------------------------------------------------------------------------- */

/**
 * Round-trip the JSON literal assigned to a top-level `export const <name>`
 * back into a value. The writers in createDesignSystem (tokens.js) and
 * writeBlocksToPageJs (page.js) both emit `export const FOO = <json>;` so
 * a single regex unifies parsing. Returns null on no-match.
 */
function parseJsExport<T>(source: string, varName: string): T | null {
  if (!source) return null;
  const re = new RegExp(
    `export\\s+const\\s+${varName}\\s*=\\s*([\\[{][\\s\\S]*?[\\]}])\\s*;?\\s*$`,
    "m",
  );
  const raw = source.match(re)?.[1];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseTokensJsBrand(tokensJs: string): Partial<BrandTokens> | null {
  return parseJsExport<Partial<BrandTokens>>(tokensJs, "BRAND");
}

function parsePageJsBlocks(pageJs: string): PageBlock[] {
  const parsed = parseJsExport<unknown>(pageJs, "PAGE");
  return Array.isArray(parsed) ? (parsed as PageBlock[]) : [];
}

function pickProp(block: PageBlock | undefined, key: string): unknown {
  if (!block) return undefined;
  const props = block.props as Record<string, unknown> | undefined;
  return props ? props[key] : undefined;
}

function findBlock(
  blocks: PageBlock[],
  section: string,
): PageBlock | undefined {
  return blocks.find((b) => b.section === section);
}

/**
 * Read the first string-valued prop among an alias list, trimmed. Common
 * pattern across the prop contracts (subtitle/sub, question/q, etc.).
 */
function pickString(
  block: PageBlock | undefined,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const v = pickProp(block, key);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Read an array-of-objects prop and project each element through a
 * picker function, dropping nulls. Used by the GEO extractors to turn
 * raw block items into clean typed lists.
 */
function pickArray<T>(
  block: PageBlock | undefined,
  key: string,
  picker: (item: Record<string, unknown>) => T | null,
): T[] {
  const raw = pickProp(block, key);
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const projected = picker(it as Record<string, unknown>);
    if (projected !== null) out.push(projected);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * GEO shape extractors
 *
 * One layer that owns the "given a blocks array, here are the clean
 * facts" question. Both buildJsonLdGraph and buildLlmsTxt consume these.
 * When the prop contract for a section changes (new alias for a field,
 * new field source), update the extractor — no need to touch both
 * builders.
 * ------------------------------------------------------------------- */

interface QAPair {
  q: string;
  a: string;
}
interface StatLine {
  value: string;
  label: string;
}
interface FeatureItem {
  title: string;
  body: string | null;
}
interface PricingPlan {
  name: string;
  price: string | null;
  description: string | null;
}
interface TimelineEntry {
  date: string | null;
  title: string;
  body: string | null;
}
interface MetricEntry {
  label: string;
  current: string | number;
  target: string | number | null;
  unit: string | null;
}
interface BylineEntry {
  author: string;
  date: string | null;
}

function extractFAQPairs(blocks: PageBlock[]): QAPair[] {
  return pickArray<QAPair>(findBlock(blocks, "FAQ"), "items", (rec) => {
    const q =
      typeof rec.question === "string"
        ? rec.question
        : typeof rec.q === "string"
          ? rec.q
          : "";
    const a =
      typeof rec.answer === "string"
        ? rec.answer
        : typeof rec.a === "string"
          ? rec.a
          : "";
    if (!q.trim() || !a.trim()) return null;
    return { q: q.trim(), a: a.trim() };
  });
}

function extractHeroStats(blocks: PageBlock[]): StatLine[] {
  return pickArray<StatLine>(findBlock(blocks, "Hero"), "stats", (rec) => {
    const v = rec.value ?? rec.number;
    const l = rec.label;
    if (typeof v !== "string" || typeof l !== "string") return null;
    if (!v.trim() || !l.trim()) return null;
    return { value: v.trim(), label: l.trim() };
  });
}

function extractStatStripItems(blocks: PageBlock[]): StatLine[] {
  return pickArray<StatLine>(findBlock(blocks, "StatStrip"), "items", (rec) => {
    const v = rec.value ?? rec.number;
    const l = rec.label;
    if (typeof v !== "string" || typeof l !== "string") return null;
    if (!v.trim() || !l.trim()) return null;
    return { value: v.trim(), label: l.trim() };
  });
}

function extractFeatureItems(blocks: PageBlock[]): FeatureItem[] {
  return pickArray<FeatureItem>(
    findBlock(blocks, "FeatureGrid"),
    "items",
    (rec) => {
      const title = typeof rec.title === "string" ? rec.title.trim() : "";
      if (!title) return null;
      const body = typeof rec.body === "string" ? rec.body.trim() : "";
      return { title, body: body || null };
    },
  );
}

function extractPricingPlans(blocks: PageBlock[]): PricingPlan[] {
  const pricing = findBlock(blocks, "PricingCards");
  // The prop contract uses `plans`; tolerate legacy `tiers`.
  const sourceKey =
    pickProp(pricing, "plans") !== undefined ? "plans" : "tiers";
  return pickArray<PricingPlan>(pricing, sourceKey, (rec) => {
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name) return null;
    const price = typeof rec.price === "string" ? rec.price.trim() : "";
    const description =
      typeof rec.description === "string" ? rec.description.trim() : "";
    return { name, price: price || null, description: description || null };
  });
}

function extractTimelineEntries(blocks: PageBlock[]): TimelineEntry[] {
  return pickArray<TimelineEntry>(
    findBlock(blocks, "Timeline"),
    "items",
    (rec) => {
      const title = typeof rec.title === "string" ? rec.title.trim() : "";
      if (!title) return null;
      const date = typeof rec.date === "string" ? rec.date.trim() : "";
      const body = typeof rec.body === "string" ? rec.body.trim() : "";
      return { title, date: date || null, body: body || null };
    },
  );
}

function extractMetricsEntries(blocks: PageBlock[]): MetricEntry[] {
  return pickArray<MetricEntry>(
    findBlock(blocks, "MetricsGrid"),
    "items",
    (rec) => {
      const label = typeof rec.label === "string" ? rec.label.trim() : "";
      if (!label || rec.current == null) return null;
      const current = rec.current as string | number;
      const target = (rec.target ?? null) as string | number | null;
      const unit = typeof rec.unit === "string" ? rec.unit.trim() : "";
      return { label, current, target, unit: unit || null };
    },
  );
}

function extractByline(blocks: PageBlock[]): BylineEntry | null {
  const byline = findBlock(blocks, "Byline");
  if (!byline) return null;
  const author = pickString(byline, "author");
  if (!author) return null;
  const date = pickString(byline, "date");
  return { author, date };
}

function extractLongFormFirstParagraph(blocks: PageBlock[]): string | null {
  const longForm = findBlock(blocks, "LongFormBody");
  const paragraphs = pickProp(longForm, "paragraphs");
  if (!Array.isArray(paragraphs)) return null;
  const first = paragraphs[0];
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

/**
 * Build a schema.org @graph for the page. Includes Organization +
 * WebSite + WebPage (with speakable selectors) always, plus FAQPage when
 * the page has a FAQ block.
 *
 * We deliberately OMIT \`url\` / \`sameAs\` since the exported bundle has
 * no canonical deployment URL — emitting a wrong url is worse than no
 * url. Once the user deploys, they can find/replace the placeholder
 * \`@id\` slugs with absolute URLs.
 */
function buildJsonLdGraph(args: {
  pageName: string;
  brandName: string;
  blocks: PageBlock[];
}): unknown {
  const { pageName, brandName, blocks } = args;
  const orgId = "#organization";
  const siteId = "#website";
  const pageId = "#webpage";

  const graph: Array<Record<string, unknown>> = [];

  // Organization
  const hero = findBlock(blocks, "Hero");
  const heroSubtitle = pickString(hero, "subtitle", "sub");
  const knowsAbout = extractFeatureItems(blocks).map((i) => i.title);
  const org: Record<string, unknown> = {
    "@type": "Organization",
    "@id": orgId,
    name: brandName,
  };
  if (heroSubtitle) org.description = heroSubtitle;
  if (knowsAbout.length > 0) org.knowsAbout = knowsAbout;
  graph.push(org);

  // WebSite
  graph.push({
    "@type": "WebSite",
    "@id": siteId,
    name: pageName,
    publisher: { "@id": orgId },
  });

  // FAQPage (only when FAQ block has real Q/A pairs)
  const faqPairs = extractFAQPairs(blocks);
  if (faqPairs.length > 0) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: faqPairs.map((p) => ({
        "@type": "Question",
        name: p.q,
        acceptedAnswer: { "@type": "Answer", text: p.a },
      })),
    });
  }

  // Article — only when the page has a Byline (memo / post / strategy
  // doc). Generic landing pages skip this because the required
  // dateModified would be fabricated.
  const byline = extractByline(blocks);
  if (byline) {
    const headline =
      pickString(hero, "title") ??
      pickString(findBlock(blocks, "LongFormBody"), "title") ??
      pageName;
    const firstPara = extractLongFormFirstParagraph(blocks);
    const article: Record<string, unknown> = {
      "@type": "Article",
      headline,
      author: { "@type": "Person", name: byline.author },
      publisher: { "@id": orgId },
    };
    if (byline.date) {
      article.datePublished = byline.date;
      article.dateModified = byline.date;
    }
    if (firstPara) article.description = firstPara.slice(0, 240);
    graph.push(article);
  }

  // WebPage with speakable selectors. .lede = Hero subtitle, .faq-answer
  // = each FAQ item's answer paragraph. Both classes are emitted by
  // templates.ts.
  graph.push({
    "@type": "WebPage",
    "@id": pageId,
    name: pageName,
    isPartOf: { "@id": siteId },
    about: { "@id": orgId },
    speakable: {
      "@type": "SpeakableSpecification",
      cssSelector: [".lede", ".faq-answer"],
    },
  });

  return { "@context": "https://schema.org", "@graph": graph };
}

/**
 * Build an llms.txt for the page. Sections derived from the blocks:
 *   - H1: page name
 *   - blockquote: hero subtitle (or generated fallback)
 *   - ## About: hero details
 *   - ## Features: from FeatureGrid items
 *   - ## Pricing: from PricingCards plans
 *   - ## FAQ: from FAQ items (truncated to first 30 words per answer)
 *   - ## Key Facts: from StatStrip items + Hero stats
 */
function buildLlmsTxt(args: {
  pageName: string;
  brandName: string;
  blocks: PageBlock[];
}): string {
  const { pageName, brandName, blocks } = args;
  const lines: string[] = [];
  const section = (title: string) => {
    lines.push(`## ${title}`);
  };

  const hero = findBlock(blocks, "Hero");
  const heroSubtitle = pickString(hero, "subtitle", "sub");
  const heroTitle = pickString(hero, "title");

  // H1 + blockquote
  lines.push(`# ${pageName}`);
  lines.push("");
  const blurb = heroSubtitle || `${brandName} — landing page.`;
  lines.push(`> ${blurb.slice(0, 200)}`);
  lines.push("");

  // ## About
  if (hero) {
    section("About");
    lines.push(`- ${heroTitle || brandName}: ${heroSubtitle || "—"}`);
    lines.push("");
  }

  // ## Features
  const features = extractFeatureItems(blocks);
  if (features.length > 0) {
    section("Features");
    for (const f of features)
      lines.push(`- ${f.title}${f.body ? `: ${f.body}` : ""}`);
    lines.push("");
  }

  // ## Pricing
  const plans = extractPricingPlans(blocks);
  if (plans.length > 0) {
    section("Pricing");
    for (const p of plans) {
      const priceTag = p.price ? ` (${p.price})` : "";
      const desc = p.description ? `: ${p.description}` : "";
      lines.push(`- ${p.name}${priceTag}${desc}`);
    }
    lines.push("");
  }

  // ## FAQ (answer trimmed to 30 words)
  const faqs = extractFAQPairs(blocks);
  if (faqs.length > 0) {
    section("FAQ");
    for (const f of faqs) {
      const words = f.a.split(/\s+/);
      const teaser =
        words.slice(0, 30).join(" ") + (words.length > 30 ? "…" : "");
      lines.push(`- ${f.q}: ${teaser}`);
    }
    lines.push("");
  }

  // ## Roadmap (from Timeline)
  const milestones = extractTimelineEntries(blocks);
  if (milestones.length > 0) {
    section("Roadmap");
    for (const m of milestones) {
      const datePrefix = m.date ? `${m.date} — ` : "";
      const body = m.body ? `: ${m.body}` : "";
      lines.push(`- ${datePrefix}${m.title}${body}`);
    }
    lines.push("");
  }

  // ## Key Facts (Hero.stats + StatStrip.items + MetricsGrid current)
  const facts: string[] = [];
  for (const s of extractHeroStats(blocks)) facts.push(`${s.value} ${s.label}`);
  for (const s of extractStatStripItems(blocks))
    facts.push(`${s.value} ${s.label}`);
  for (const m of extractMetricsEntries(blocks)) {
    const unitSuffix = m.unit ? ` ${m.unit}` : "";
    const targetPart =
      m.target != null ? ` / ${m.target}${unitSuffix}` : unitSuffix;
    facts.push(`${m.label}: ${m.current}${targetPart}`);
  }
  if (facts.length > 0) {
    section("Key Facts");
    for (const f of facts) lines.push(`- ${f}`);
    lines.push("");
  }

  // ## Article (first paragraph of LongFormBody as teaser, 60 words)
  const firstPara = extractLongFormFirstParagraph(blocks);
  if (firstPara) {
    section("Article");
    const lfTitle = pickString(findBlock(blocks, "LongFormBody"), "title");
    if (lfTitle) lines.push(`- ${lfTitle}`);
    const words = firstPara.split(/\s+/);
    const teaser =
      words.slice(0, 60).join(" ") + (words.length > 60 ? "…" : "");
    lines.push(`- ${teaser}`);
    lines.push("");
  }

  section("Contact");
  lines.push(`- Brand: ${brandName}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Build a robots.txt that explicitly allow-lists AI crawlers so a future
 * \`User-agent: *\` rule never accidentally blocks them. The
 * \`Content-Signal\` line is the emerging convention (still draft, see
 * pr-draft-content-signals in geo-seo-claude) for declaring training /
 * search / retrieval intent in one directive.
 */
function buildRobotsTxt(): string {
  const aiCrawlers = [
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    "ClaudeBot",
    "PerplexityBot",
    "Amazonbot",
    "Google-Extended",
    "Bytespider",
    "CCBot",
    "Applebot-Extended",
    "FacebookBot",
    "Cohere-ai",
  ];
  const lines: string[] = [];
  lines.push("# Explicitly allow AI search crawlers so they can read, cite,");
  lines.push("# and surface this page in ChatGPT, Claude, Perplexity, Gemini,");
  lines.push("# Google AI Overviews, and Bing Copilot.");
  lines.push("");
  for (const ua of aiCrawlers) {
    lines.push(`User-agent: ${ua}`);
    lines.push("Allow: /");
    lines.push("");
  }
  lines.push("User-agent: *");
  lines.push("Allow: /");
  lines.push("");
  lines.push(
    "# Emerging convention — declare training / search / retrieval intent.",
  );
  lines.push("Content-Signal: ai-train=yes, search=yes, ai-retrieval=yes");
  lines.push("");
  return lines.join("\n");
}

/**
 * Build the file set for a page export. Always emits:
 *   - <bundle>/index.html — self-contained, double-click ready
 *   - <bundle>/README.txt — short usage note
 *
 * The original source files are also bundled under <bundle>/src/ for
 * advanced users who want to keep editing in the Studio layout.
 */
export async function buildPageExportBundle(
  options: PagePreviewOptions & { slug: string },
): Promise<{
  bundleName: string;
  files: Array<{ relativePath: string; data: Uint8Array }>;
}> {
  const slug = slugify(options.slug);
  if (!slug) throw new Error("Invalid slug");
  const { objectStorage } = options;

  const indexHtml = await readTextObject(
    objectStorage,
    pageObjKey(slug, "index.html"),
  );
  if (indexHtml == null) {
    throw new Error(`page "${slug}" not found`);
  }
  const pageMeta =
    (await readJsonObject<PageMeta>(
      objectStorage,
      pageObjKey(slug, PAGE_META_FILE),
    )) ?? {};
  const dsSlug = pageMeta.designSystem ?? null;

  const [appJs, sectionsJs, pageJs] = await Promise.all([
    readTextObject(objectStorage, pageObjKey(slug, "app.js")).then(
      (s) => s ?? "",
    ),
    readTextObject(objectStorage, pageObjKey(slug, "sections.js")).then(
      (s) => s ?? "",
    ),
    readTextObject(objectStorage, pageObjKey(slug, "page.js")).then(
      (s) => s ?? "",
    ),
  ]);

  let tokensCss = "";
  let tokensJs = "";
  if (dsSlug) {
    tokensCss =
      (await readTextObject(objectStorage, dsObjKey(dsSlug, "tokens.css"))) ??
      "";
    tokensJs =
      (await readTextObject(objectStorage, dsObjKey(dsSlug, "tokens.js"))) ??
      "";
  }

  // Strip `export ` so the inline module sees `BRAND`, `Nav`, etc. as
  // ordinary top-level bindings rather than ESM exports.
  const stripExports = (src: string) =>
    src.replace(/^\s*export\s+default\s+/gm, "").replace(/^\s*export\s+/gm, "");

  // Each chunk independently imports `h`/`htm` and declares
  // `const html = htm.bind(h)`; concatenating verbatim re-declares those at
  // top level and the browser throws "Identifier 'h' has already been
  // declared". Strip every import and html-binding from each chunk; we'll
  // hoist a single canonical set at the top of the inline module.
  const normalize = (src: string) =>
    stripHtmBindLine(stripAllImports(stripExports(src)));

  // `app.js` references `Sections[block.section]`, expecting the namespace
  // object created by `import * as Sections from './sections.js'`. After
  // we strip the import (and `export ` from each function declaration in
  // sections.js), the section functions are loose top-level bindings —
  // there's no `Sections` namespace. Reconstruct one from the export
  // names we find in the raw sections.js source.
  const sectionExportNames = extractSectionExports(sectionsJs);
  const sectionsNamespace =
    sectionExportNames.length > 0
      ? `const Sections = { ${sectionExportNames.join(", ")} };`
      : `const Sections = {};`;

  const inlineModule = [
    // Single canonical imports + html binding for the whole inline module.
    "import { h, render, Component } from 'preact';",
    "import htm from 'htm';",
    "const html = htm.bind(h);",
    "",
    "// === tokens.js ===",
    normalize(tokensJs),
    "// === sections.js ===",
    normalize(sectionsJs),
    "// Reconstruct the namespace `app.js` expects from `import * as Sections`.",
    sectionsNamespace,
    "// === page.js ===",
    normalize(pageJs),
    "// === app.js ===",
    normalize(appJs),
  ].join("\n\n");

  // Rewrite the index.html:
  //   - Remove the stylesheet <link> to ../../design-systems/<slug>/tokens.css
  //     (replace with an inline <style> block carrying the CSS).
  //   - Remove the <script type="module" src="./app.js"></script> tag and
  //     inject our consolidated inline module instead.
  let html = indexHtml;
  html = html.replace(
    /<link[^>]*?href=["'][^"']*design-systems\/[^"']*tokens\.css[^"']*["'][^>]*?>/g,
    `<style>\n${tokensCss}\n</style>`,
  );
  html = html.replace(
    /<script[^>]*?src=["']\.\/app\.js["'][^>]*?>\s*<\/script>/g,
    `<script type="module">\n${inlineModule}\n</script>`,
  );

  // GEO artifacts — JSON-LD @graph in <head> (server-rendered, AI
  // crawlers don't execute JS) + sibling llms.txt + robots.txt.
  const brand = parseTokensJsBrand(tokensJs);
  const blocks = parsePageJsBlocks(pageJs);
  const pageName = pageMeta.name ?? slug;
  const brandName = brand?.name ?? pageName;
  const jsonLd = buildJsonLdGraph({ pageName, brandName, blocks });
  const jsonLdScript = `<script type="application/ld+json">\n${JSON.stringify(jsonLd, null, 2)}\n</script>`;
  // Inject right before </head>. The placeholder index.html always has
  // a </head>; if a future template change drops it, we'll catch this
  // in tests because the JSON-LD won't end up in the served HTML.
  html = html.replace(/<\/head>/i, `${jsonLdScript}\n</head>`);

  const llmsTxt = buildLlmsTxt({ pageName, brandName, blocks });
  const robotsTxt = buildRobotsTxt();

  const enc = new TextEncoder();
  const files: Array<{ relativePath: string; data: Uint8Array }> = [
    { relativePath: "index.html", data: enc.encode(html) },
    { relativePath: "llms.txt", data: enc.encode(llmsTxt) },
    { relativePath: "robots.txt", data: enc.encode(robotsTxt) },
    {
      relativePath: "README.txt",
      data: enc.encode(
        `${pageMeta.name ?? slug} — exported from Page Editor\n\n` +
          `Open index.html in a browser to view the page.\n` +
          `Everything is self-contained except CDN-hosted preact + htm.\n\n` +
          `Also included for AI search visibility:\n` +
          `  - llms.txt   — site overview for LLM crawlers (host at /llms.txt)\n` +
          `  - robots.txt — AI crawler allow-list (host at /robots.txt)\n` +
          `  - JSON-LD @graph in <head> — Organization + WebSite + WebPage\n` +
          `    + speakable, plus FAQPage when the page has a FAQ.\n` +
          `    The JSON-LD uses fragment @ids (#organization etc.); once you\n` +
          `    deploy, find/replace them with absolute URLs for the strongest\n` +
          `    entity grounding.\n\n` +
          `If you'd rather edit the original multi-file source, see ./src/.\n`,
      ),
    },
  ];

  // Also include the raw source files under ./src/ for advanced users.
  const enc2 = new TextEncoder();
  const includeRaw = async (name: string, content?: string) => {
    if (typeof content === "string") {
      files.push({
        relativePath: `src/${name}`,
        data: enc2.encode(content),
      });
    }
  };
  await includeRaw("index.html", indexHtml);
  await includeRaw("app.js", appJs);
  if (sectionsJs) await includeRaw("sections.js", sectionsJs);
  if (pageJs) await includeRaw("page.js", pageJs);
  if (tokensCss) await includeRaw("tokens.css", tokensCss);
  if (tokensJs) await includeRaw("tokens.js", tokensJs);
  const metaSrc =
    (await readTextObject(objectStorage, pageObjKey(slug, PAGE_META_FILE))) ??
    "";
  if (metaSrc) await includeRaw("meta.json", metaSrc);

  return { bundleName: `page-${slug}`, files };
}

/**
 * Build the file set for a design-system export. The demo page already
 * loads `./tokens.css` (sibling) so it works from `file://` — but `tokens.js`
 * is imported via ES module and would be blocked by file:// CORS. We inline
 * tokens.js into demo.html the same way as for pages.
 */
export async function buildDesignSystemExportBundle(
  options: PagePreviewOptions & { slug: string },
): Promise<{
  bundleName: string;
  files: Array<{ relativePath: string; data: Uint8Array }>;
}> {
  const slug = slugify(options.slug);
  if (!slug) throw new Error("Invalid slug");
  const { objectStorage } = options;
  const demoHtml = await readTextObject(
    objectStorage,
    dsObjKey(slug, "demo.html"),
  );
  if (demoHtml == null) {
    throw new Error(`design system "${slug}" not found`);
  }
  const [demoJs, tokensJs, tokensCss] = await Promise.all([
    readTextObject(objectStorage, dsObjKey(slug, "demo.js")).then(
      (s) => s ?? "",
    ),
    readTextObject(objectStorage, dsObjKey(slug, "tokens.js")).then(
      (s) => s ?? "",
    ),
    readTextObject(objectStorage, dsObjKey(slug, "tokens.css")).then(
      (s) => s ?? "",
    ),
  ]);

  const stripExports = (src: string) =>
    src.replace(/^\s*export\s+default\s+/gm, "").replace(/^\s*export\s+/gm, "");

  // demo.js is plain DOM code (no preact / htm), but tokens.js exports
  // BRAND which demo.js imports. Strip all imports from both chunks so we
  // can concatenate safely; tokens.js's BRAND becomes a top-level binding.
  const normalize = (src: string) => stripAllImports(stripExports(src));

  const inlineModule = [
    "// === tokens.js ===",
    normalize(tokensJs),
    "// === demo.js ===",
    normalize(demoJs),
  ].join("\n\n");

  let html = demoHtml;
  html = html.replace(
    /<script[^>]*?src=["']\.\/demo\.js["'][^>]*?>\s*<\/script>/g,
    `<script type="module">\n${inlineModule}\n</script>`,
  );

  const metaSrc =
    (await readTextObject(
      objectStorage,
      dsObjKey(slug, DESIGN_SYSTEM_META_FILE),
    )) ?? "";

  const enc = new TextEncoder();
  const files: Array<{ relativePath: string; data: Uint8Array }> = [
    { relativePath: "demo.html", data: enc.encode(html) },
    { relativePath: "tokens.css", data: enc.encode(tokensCss) },
    {
      relativePath: "README.txt",
      data: enc.encode(
        `${slug} — design system exported from Page Editor\n\n` +
          `Open demo.html in a browser to view the design system gallery.\n` +
          `tokens.css carries the brand variables (CSS custom properties).\n`,
      ),
    },
  ];
  if (metaSrc) {
    files.push({ relativePath: "meta.json", data: enc.encode(metaSrc) });
  }
  if (tokensJs) {
    files.push({ relativePath: "tokens.js", data: enc.encode(tokensJs) });
  }

  return { bundleName: `design-system-${slug}`, files };
}

/* ---------------------------------------------------------------------------
 * Live block store — server-side mirror of the iframe's active page state.
 *
 * The browser-as-REPL flow keeps a page's section list IN MEMORY here while
 * the agent is authoring. Each PAGE_RENDER_BLOCK / UPDATE_BLOCK / REMOVE_BLOCK
 * tool call mutates this store synchronously, returns a tiny payload to the
 * agent, then kicks off an async background write to `pages/<slug>/page.js`
 * so the on-disk artifact stays usable for export and tab reloads.
 *
 * Why this is on the server (and not exclusively in the iframe):
 *
 *   - Tools need to confirm the mutation happened (return `index`,
 *     `blockCount`) without waiting for a postMessage round-trip back
 *     from the iframe.
 *   - Export reads from disk; the async write-through guarantees disk
 *     catches up.
 *   - Tab reloads see the in-memory state preserved at the server level
 *     even if the iframe momentarily loses it.
 * ------------------------------------------------------------------------- */

export interface PageBlock {
  /** Library section name — must match an export in `sections.js`. */
  section: string;
  /** Free-form prop bag passed to the section component. */
  props: Record<string, unknown>;
}

/** Keyed by `<orgId>::<slug>` so multi-org dev setups don't collide. */
const liveBlocks = new Map<string, PageBlock[]>();

function blocksKey(orgId: string, slug: string): string {
  return `${orgId}::${slug}`;
}

function getOrInitBlocks(orgId: string, slug: string): PageBlock[] {
  const key = blocksKey(orgId, slug);
  let existing = liveBlocks.get(key);
  if (!existing) {
    existing = [];
    liveBlocks.set(key, existing);
  }
  return existing;
}

export function getBlocks(
  options: PagePreviewOptions & { slug: string },
): PageBlock[] {
  return [...getOrInitBlocks(options.orgId, options.slug)];
}

/**
 * Reset the in-memory block list — called from `createPage` so a fresh
 * scaffold doesn't inherit a stale block list from a prior session.
 */
export function resetBlocks(
  options: PagePreviewOptions & { slug: string },
): void {
  liveBlocks.set(blocksKey(options.orgId, options.slug), []);
}

/**
 * Set of valid section names — must match the exports in sections.js
 * (page-preview/templates.ts: SECTIONS_JS). Used to fail PAGE_RENDER_BLOCK
 * fast when the agent passes a typo or invented name, instead of letting
 * the iframe render "Unknown section: X" silently. Exported so the agent's
 * INSTRUCTIONS prompt can reference the live list instead of hand-syncing.
 */
export const KNOWN_SECTION_NAMES = new Set([
  // Landing-page sections
  "Nav",
  "Hero",
  "FeatureGrid",
  "PricingCards",
  "TestimonialQuote",
  "TestimonialGrid",
  "LogoStrip",
  "StatStrip",
  "Steps",
  "ProblemSolution",
  "FAQ",
  "EmailCapture",
  "CTASection",
  "Footer",
  // Beyond-landing — internal narrative, OKR / status docs, blog posts,
  // light data viz, decision pages. Same factory pattern; same prop
  // shape contract; same export bundle pipeline.
  "MetricsGrid",
  "Timeline",
  "Chart",
  "Callout",
  "KeyTakeaways",
  "LongFormBody",
  "Byline",
  "Comparison",
  "BeforeAfter",
  "Banner",
]);

/**
 * Cheap closest-match suggestion for an invalid section name. Used to
 * help the agent recover from a typo without listing all 14 names.
 * Returns null if nothing is suspiciously close.
 */
function closestSectionMatch(name: string): string | null {
  const target = name.toLowerCase();
  let best: { name: string; score: number } | null = null;
  for (const candidate of KNOWN_SECTION_NAMES) {
    const c = candidate.toLowerCase();
    let score = 0;
    if (c === target) score = 100;
    else if (c.includes(target) || target.includes(c)) score = 60;
    else {
      // Count shared 3-letter prefixes — catches "feat" → "FeatureGrid".
      const prefix = Math.min(c.length, target.length, 4);
      for (let i = 0; i < prefix; i++) {
        if (c[i] === target[i]) score++;
        else break;
      }
    }
    if (!best || score > best.score) best = { name: candidate, score };
  }
  return best && best.score >= 3 ? best.name : null;
}

export interface AppendBlockResult {
  index: number;
  blockCount: number;
  /** Agent-declared section outline (read from state) or null. */
  outline: string[] | null;
  /** Section names already rendered (in order). */
  sectionsRendered: string[];
}

/**
 * Append a section block to the end of the page.
 *
 * Design choice: no positional inserts. Sections always append. The agent
 * is responsible for shipping sections in the order they should appear on
 * the page — making the agent track array indices is cognitive overhead
 * that empirically degrades quality (sections get skipped or misordered).
 * The host iframe and Studio dispatch path mirror this: append-only.
 */
export async function appendBlock(
  options: PagePreviewOptions & {
    slug: string;
    block: PageBlock;
  },
): Promise<AppendBlockResult> {
  // Fail fast and LLM-first when the agent calls PAGE_RENDER_BLOCK before
  // PAGE_PREVIEW_PAGE_CREATE. The previous behavior was to silently spawn
  // an in-memory block list for a nonexistent page slug; the agent would
  // then think the build was succeeding (no error response) and proceed to
  // claim "Done — your page is live" while the user saw nothing rendered.
  // Now we throw with the exact remediation: literally the tool call the
  // agent needs to make instead.
  const slug = slugify(options.slug);
  const pageExists = await statObject(
    options.objectStorage,
    pageObjKey(slug, "index.html"),
  );
  if (!pageExists) {
    throw new Error(
      `Page "${options.slug}" does not exist. You must call PAGE_PREVIEW_PAGE_CREATE first. Required next call: PAGE_PREVIEW_PAGE_CREATE({ slug: "${options.slug}", designSystem: "<your-ds-slug>" }) — then retry this PAGE_RENDER_BLOCK call.`,
    );
  }
  // Validate the section name against the known library so a typo doesn't
  // silently render as "Unknown section: X" in the iframe.
  if (!KNOWN_SECTION_NAMES.has(options.block.section)) {
    const suggestion = closestSectionMatch(options.block.section);
    const suggestionHint = suggestion ? ` Did you mean "${suggestion}"?` : "";
    throw new Error(
      `Unknown section "${options.block.section}".${suggestionHint} Valid section names (verbatim, case-sensitive): ${[...KNOWN_SECTION_NAMES].join(", ")}.`,
    );
  }
  const blocks = getOrInitBlocks(options.orgId, options.slug);
  // Reject duplicate section names. The agent has occasionally re-shipped
  // already-rendered sections (e.g. two Footers, or a second Hero with
  // updated copy) — LLM-first fix: tell it to use PAGE_UPDATE_BLOCK
  // instead. This also catches the "page keeps growing after Footer"
  // failure mode.
  const dupeIdx = blocks.findIndex((b) => b.section === options.block.section);
  if (dupeIdx >= 0) {
    throw new Error(
      `Section "${options.block.section}" was already shipped (at index ${dupeIdx}). To modify its props, call PAGE_UPDATE_BLOCK({ slug: "${options.slug}", index: ${dupeIdx}, props: {...} }). To remove and reship, call PAGE_REMOVE_BLOCK first. Do NOT call PAGE_RENDER_BLOCK with the same section again.`,
    );
  }
  // Reject any RENDER_BLOCK after Footer has been shipped — Footer
  // marks the page is structurally complete; further blocks belong
  // below the Footer visually, which is never what the user wants.
  const footerIdx = blocks.findIndex((b) => /^footer$/i.test(b.section));
  if (footerIdx >= 0) {
    throw new Error(
      `Footer has already been shipped (at index ${footerIdx}); the page is structurally complete. Do NOT call PAGE_RENDER_BLOCK again. If you want to add another section, you must first PAGE_REMOVE_BLOCK the Footer, ship your new section, then re-ship Footer last.`,
    );
  }
  blocks.push({
    section: options.block.section,
    props: sanitizeBlockProps(options.block.props ?? {}),
  });
  // Bump the refresh counter — frontend observers may still use it as a
  // cache key for the legacy file-based flow. Cheap to write.
  await bumpRefreshVersion(options);
  // Fire-and-forget disk persistence; do NOT block the tool response.
  void writeBlocksToPageJs(options.slug, blocks, options).catch((err) => {
    console.warn(
      "[page-editor] background page.js write failed:",
      options.slug,
      err,
    );
  });
  // Read outline so the tool layer can build an LLM-friendly nextStep
  // naming the *remaining* sections. Don't trust the agent to track its
  // own outline — surface it from server state.
  const state = await readState(options.objectStorage);
  return {
    index: blocks.length - 1,
    blockCount: blocks.length,
    outline: state.outline ?? null,
    sectionsRendered: blocks.map((b) => b.section),
  };
}

export interface UpdateBlockResult {
  ok: true;
  blockCount: number;
}

export async function updateBlock(
  options: PagePreviewOptions & {
    slug: string;
    index: number;
    propsPatch: Record<string, unknown>;
    /** When true, replace the props object entirely. Default: shallow merge. */
    replace?: boolean;
  },
): Promise<UpdateBlockResult> {
  const blocks = getOrInitBlocks(options.orgId, options.slug);
  if (options.index < 0 || options.index >= blocks.length) {
    throw new Error(
      `Block index ${options.index} out of range (have ${blocks.length} blocks on page "${options.slug}")`,
    );
  }
  const current = blocks[options.index]!;
  const patch = sanitizeBlockProps(options.propsPatch ?? {});
  const nextProps = options.replace ? patch : { ...current.props, ...patch };
  blocks[options.index] = { section: current.section, props: nextProps };
  await bumpRefreshVersion(options);
  void writeBlocksToPageJs(options.slug, blocks, options).catch((err) => {
    console.warn(
      "[page-editor] background page.js write failed:",
      options.slug,
      err,
    );
  });
  return { ok: true, blockCount: blocks.length };
}

export interface RemoveBlockResult {
  ok: true;
  blockCount: number;
}

export async function removeBlock(
  options: PagePreviewOptions & { slug: string; index: number },
): Promise<RemoveBlockResult> {
  const blocks = getOrInitBlocks(options.orgId, options.slug);
  if (options.index < 0 || options.index >= blocks.length) {
    throw new Error(
      `Block index ${options.index} out of range (have ${blocks.length} blocks on page "${options.slug}")`,
    );
  }
  blocks.splice(options.index, 1);
  await bumpRefreshVersion(options);
  void writeBlocksToPageJs(options.slug, blocks, options).catch((err) => {
    console.warn(
      "[page-editor] background page.js write failed:",
      options.slug,
      err,
    );
  });
  return { ok: true, blockCount: blocks.length };
}

/**
 * Bump `state.json`'s `refreshVersion` so any legacy observer paths that
 * key on it (e.g. iframe module re-imports for the old file-based flow)
 * still see the change. Cheap to write.
 */
async function bumpRefreshVersion(options: PagePreviewOptions): Promise<void> {
  const { objectStorage } = options;
  await withStateLock(options.orgId, async () => {
    const current = await readState(objectStorage);
    await writeState(objectStorage, {
      ...current,
      refreshVersion: current.refreshVersion + 1,
      updatedAt: new Date().toISOString(),
    });
  });
}

/**
 * Serialize the in-memory block list to `pages/<slug>/page.js`. Runs in
 * the background after every mutation. `JSON.stringify` produces valid JS
 * for the array literal — no template renderer required.
 */
async function writeBlocksToPageJs(
  slug: string,
  blocks: readonly PageBlock[],
  options: PagePreviewOptions,
): Promise<void> {
  const source =
    "/**\n" +
    " * Ordered list of section blocks rendered by app.js.\n" +
    " *\n" +
    " * This file is auto-written by the Page Editor on every block\n" +
    " * mutation. The in-iframe preview reads from server state during\n" +
    " * authoring; this file is the durable export-target snapshot.\n" +
    " */\n" +
    `export const PAGE = ${JSON.stringify(blocks, null, 2)};\n`;
  await writeTextObject(
    options.objectStorage,
    pageObjKey(slug, "page.js"),
    source,
    "application/javascript; charset=utf-8",
  );
}
