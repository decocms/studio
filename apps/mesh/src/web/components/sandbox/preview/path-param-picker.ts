import {
  normalizePagePath,
  splitPathTemplate,
} from "@/web/components/sections-editor/page-path-utils";

/** Entity kind a path param can be filled from. */
export type PathParamKind = "product" | "category";

export interface PathParamOption {
  /** Committed into the param — never has a leading slash. */
  value: string;
  label: string;
  image?: string;
}

export interface PickerLoaderRequest {
  resolveType: string;
  props: Record<string, unknown>;
}

/** Context a payload mapper needs to derive param values relative to the route. */
export interface OptionPayloadContext {
  template: string;
  paramName: string;
}

/**
 * A concrete way to enumerate options for one kind: the manifest loader to
 * invoke, the requests to build from a search term, and how to map the payload.
 * Bound to a specific `resolveType` discovered in the running site's manifest.
 */
export interface OptionSource {
  kind: PathParamKind;
  /** Stable id — also the react-query cache-key discriminator. */
  id: string;
  /** Loader invoked to enumerate options (present in the manifest). */
  resolveType: string;
  /** Options fetched once (term-independent) and filtered client-side. */
  clientFilter: boolean;
  buildRequests: (term: string) => PickerLoaderRequest[];
  optionsFromPayload: (
    payload: unknown,
    ctx: OptionPayloadContext,
  ) => PathParamOption[];
}

/**
 * Loaders whose presence on a page classify its dynamic param. Matched against
 * the loader module resolveTypes AND the descriptive saved-block names the page
 * references (both surfaced by {@link collectPageLoaderResolveTypes}), so
 * detection is app-agnostic: it catches the `detailsPage`/`listingPage` module
 * convention (VTEX `productDetailsPage`, Magento `detailsPageGQL`, …) as well as
 * blocks a site simply named `PDP …` / `PLP …`. URL-shape is a complementary
 * fallback (see {@link classifyParamKinds}).
 */
const DETAIL_LOADER_RE = /details?page|\bpdp\b/i;
const LISTING_LOADER_RE = /listingpage|\bplp\b/i;

/**
 * Kinds a path param can be filled from, derived from BOTH the loaders the
 * current page uses and the template shape:
 *
 * - loader-based (primary, app-agnostic): a `*detailsPage*` loader → product, a
 *   `*listingPage*` loader → category. A catch-all page that wires both (e.g.
 *   Magento's runtime PDP/PLP router) yields both.
 * - URL-shape (fallback, keeps VTEX zero-config): a `:param` right before a
 *   trailing `/p` → product; the `*` catch-all → category.
 */
export function classifyParamKinds(
  template: string,
  paramName: string,
  pageLoaders: ReadonlySet<string>,
): Set<PathParamKind> {
  const kinds = new Set<PathParamKind>();
  for (const rt of pageLoaders) {
    if (DETAIL_LOADER_RE.test(rt)) kinds.add("product");
    if (LISTING_LOADER_RE.test(rt)) kinds.add("category");
  }
  const tokens = splitPathTemplate(normalizePagePath(template));
  const last = tokens[tokens.length - 1];
  const prev = tokens[tokens.length - 2];
  if (
    last?.type === "text" &&
    last.text === "/p" &&
    prev?.type === "param" &&
    prev.name === paramName
  ) {
    kinds.add("product");
  }
  if (
    paramName === "*" &&
    tokens.some((t) => t.type === "param" && t.name === "*")
  ) {
    kinds.add("category");
  }
  return kinds;
}

/**
 * VTEX intelligent-search product requests: numeric terms also try the `ids`
 * variant (ids first), slug-like terms are de-hyphenated so their words match
 * the product name. `query`/`count` is the VTEX convention.
 */
function vtexProductRequests(
  resolveType: string,
  term: string,
): PickerLoaderRequest[] {
  const trimmed = term.trim();
  const requests: PickerLoaderRequest[] = [];
  if (/^\d+$/.test(trimmed)) {
    requests.push({ resolveType, props: { ids: [trimmed] } });
  }
  const slugLike = trimmed.includes("-") && !/\s/.test(trimmed);
  const query = slugLike ? trimmed.replace(/-+/g, " ") : trimmed;
  requests.push({ resolveType, props: { query, count: 10 } });
  return requests;
}

/**
 * Ordered candidate loaders per kind. Resolution ({@link resolveOptionSources})
 * scans the running site's manifest and binds the FIRST candidate present — so
 * the loader is discovered dynamically, not hardcoded per app (a Magento PDP
 * page classified as "product" is searched via whatever product-search loader
 * the site actually ships, e.g. Algolia). Adding an app = adding a candidate.
 */
interface OptionSourceCandidate {
  kind: PathParamKind;
  /** Whether a manifest loader resolveType can serve this candidate. */
  test: (resolveType: string) => boolean;
  clientFilter: boolean;
  buildRequests: (resolveType: string, term: string) => PickerLoaderRequest[];
  optionsFromPayload: (
    payload: unknown,
    ctx: OptionPayloadContext,
  ) => PathParamOption[];
}

/**
 * First-segment app namespaces that are commerce providers. Used to avoid
 * invoking one provider's loader on a site running another — e.g. a Magento
 * store often also has the VTEX app installed, so `vtex/loaders/...` exists in
 * the manifest and would otherwise be picked, hitting the wrong backend.
 * Neutral namespaces (`site`, `commerce`, `algolia`, …) are NOT listed and are
 * always allowed.
 */
const COMMERCE_VENDOR_NAMESPACES = new Set([
  "vtex",
  "shopify",
  "shopify-mcp",
  "magento",
  "wake",
  "linx",
  "linx-impulse",
  "nuvemshop",
  "vnda",
  "wap",
  "salesforce",
]);

function loaderVendor(resolveType: string): string {
  return resolveType.split("/")[0] ?? "";
}

/** Commerce platform namespaces a page uses, from its loader resolveTypes. */
export function commercePlatformsFromLoaders(
  loaders: Iterable<string>,
): Set<string> {
  const platforms = new Set<string>();
  for (const rt of loaders) {
    const vendor = loaderVendor(rt);
    if (COMMERCE_VENDOR_NAMESPACES.has(vendor)) platforms.add(vendor);
  }
  return platforms;
}

/**
 * Whether a loader may serve an option source given the page's platforms. A
 * loader from a commerce vendor NOT among the page's platforms is a competing
 * backend and rejected; neutral loaders (site/commerce/algolia/…) and the
 * page's own platform are allowed. No detected platform → no restriction.
 */
function allowedForPlatforms(
  resolveType: string,
  platforms: ReadonlySet<string>,
): boolean {
  const vendor = loaderVendor(resolveType);
  if (!COMMERCE_VENDOR_NAMESPACES.has(vendor)) return true;
  if (platforms.size === 0) return true;
  return platforms.has(vendor);
}

const OPTION_SOURCE_CANDIDATES: OptionSourceCandidate[] = [
  // Product search — must accept a free-text term.
  {
    kind: "product",
    test: (rt) => rt === "vtex/loaders/intelligentSearch/productList.ts",
    clientFilter: false,
    buildRequests: vtexProductRequests,
    optionsFromPayload: productOptionsFromPayload,
  },
  {
    // Magento full-text product search (`products(search:)`) — the platform's
    // own public GraphQL, preferred over a neutral search index when the page
    // is Magento (see the platform-priority pass in resolveOptionSources). Its
    // props are nested under `props` (a `TermProps`); `currentPage` is required
    // alongside `search`/`pageSize`.
    kind: "product",
    test: (rt) => /magento\/.*products?\/list(\.tsx?)?$/i.test(rt),
    clientFilter: false,
    buildRequests: (resolveType, term) => [
      {
        resolveType,
        props: { props: { search: term.trim(), pageSize: 10, currentPage: 1 } },
      },
    ],
    optionsFromPayload: productOptionsFromPayload,
  },
  {
    // Algolia product search (site-local or app), `term`/`hitsPerPage`.
    kind: "product",
    test: (rt) =>
      /algolia\/.*products?\/(list|suggestions)(\.tsx?)?$/i.test(rt),
    clientFilter: false,
    buildRequests: (resolveType, term) => [
      { resolveType, props: { term: term.trim(), hitsPerPage: 10 } },
    ],
    optionsFromPayload: productOptionsFromPayload,
  },
  {
    // Generic product-list fallback. Passes both prop conventions; Zod strips
    // the unknown ones, so a loader taking either shape still works.
    kind: "product",
    test: (rt) => /products?\/list(\.tsx?)?$/i.test(rt),
    clientFilter: false,
    buildRequests: (resolveType, term) => [
      {
        resolveType,
        props: {
          query: term.trim(),
          term: term.trim(),
          count: 10,
          hitsPerPage: 10,
        },
      },
    ],
    optionsFromPayload: productOptionsFromPayload,
  },
  // Category — a term-independent tree, filtered client-side.
  {
    kind: "category",
    test: (rt) =>
      rt === "vtex/loaders/categories/tree.ts" ||
      /categor(y|ies).*tree/i.test(rt),
    clientFilter: true,
    buildRequests: (resolveType) => [{ resolveType, props: {} }],
    optionsFromPayload: categoryOptionsFromPayload,
  },
];

/**
 * For each requested kind, bind the first candidate loader present in the
 * manifest into a concrete {@link OptionSource}. Kinds with no available loader
 * are dropped (the free-text "Use …" row and the plain inline input still let
 * the user type a value). Preserves candidate order = priority.
 */
export function resolveOptionSources(
  kinds: ReadonlySet<PathParamKind>,
  manifestLoaders: ReadonlySet<string>,
  platforms: ReadonlySet<string> = new Set(),
): OptionSource[] {
  const loaders = [...manifestLoaders];
  const sources: OptionSource[] = [];
  for (const kind of ["product", "category"] as const) {
    if (!kinds.has(kind)) continue;
    // Collect every candidate that resolves to an allowed loader, in candidate
    // order, then prefer one from the page's own platform (Magento's native
    // search over a neutral Algolia index) — otherwise take the first.
    const matches: { cand: OptionSourceCandidate; resolveType: string }[] = [];
    for (const cand of OPTION_SOURCE_CANDIDATES) {
      if (cand.kind !== kind) continue;
      const resolveType = loaders.find(
        (rt) => cand.test(rt) && allowedForPlatforms(rt, platforms),
      );
      if (resolveType) matches.push({ cand, resolveType });
    }
    const chosen =
      matches.find((m) => platforms.has(loaderVendor(m.resolveType))) ??
      matches[0];
    if (!chosen) continue;
    const { cand, resolveType } = chosen;
    sources.push({
      kind,
      id: `${kind}:${resolveType}`,
      resolveType,
      clientFilter: cand.clientFilter,
      buildRequests: (term) => cand.buildRequests(resolveType, term),
      optionsFromPayload: cand.optionsFromPayload,
    });
  }
  return sources;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Loader signals reachable from a page block, for {@link classifyParamKinds}.
 * Detail/listing loaders sit either inline in section props OR — as in the CMS
 * — behind a `__resolveType` that names another decofile block (e.g.
 * `"PDP Magento loader (GQL)"` whose block holds
 * `magento/loaders/product/detailsPageGQL.ts`). Both are followed: a
 * `__resolveType` that is a manifest loader is collected; one that is a decofile
 * key is resolved and walked (guarded against cycles). When a followed
 * reference points at a loader block, the **descriptive block key** (`"PDP …"`)
 * is collected too, so a param can be classified by the loader's name even when
 * its module doesn't follow the `detailsPage`/`listingPage` convention.
 */
export function collectPageLoaderResolveTypes(
  pageBlock: unknown,
  decofile: Record<string, unknown>,
  isLoader: (resolveType: string) => boolean,
): Set<string> {
  const found = new Set<string>();
  const visited = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const rec = asRecord(node);
    if (!rec) return;
    const rt = rec.__resolveType;
    if (typeof rt === "string") {
      if (isLoader(rt)) found.add(rt);
      // Block reference: `__resolveType` names another block — follow it so
      // loaders wired as saved blocks (not inline) are still discovered.
      else if (rt in decofile && !visited.has(rt)) {
        visited.add(rt);
        const targetRt = asRecord(decofile[rt])?.__resolveType;
        // Keep the human-readable block name as a classification signal, but
        // only for blocks that actually are loaders (avoids matching a section
        // that merely happens to be named "PDP …").
        if (typeof targetRt === "string" && isLoader(targetRt)) found.add(rt);
        walk(decofile[rt]);
      }
    }
    for (const value of Object.values(rec)) walk(value);
  };
  walk(pageBlock);
  return found;
}

/** Merge option lists in order, dropping later duplicates by value. */
export function mergePickerOptions(
  lists: PathParamOption[][],
): PathParamOption[] {
  const seen = new Set<string>();
  const merged: PathParamOption[] = [];
  for (const options of lists) {
    for (const option of options) {
      if (seen.has(option.value)) continue;
      seen.add(option.value);
      merged.push(option);
    }
  }
  return merged;
}

/** Percent-decode, tolerating malformed sequences (returns the raw string). */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The value to commit into `paramName` for an entity URL, derived RELATIVE to
 * the page template — no `/p` or provider-specific shape assumed. The template's
 * static text before and after the param is stripped from the entity pathname;
 * the remainder is the value:
 *
 * - `/apple-watch/p`            on `/:slug/p`        → `apple-watch`
 * - `/eau-de-toilette-100ml`    on `/*`              → `eau-de-toilette-100ml`
 * - `/granado/x`                on `/granado/:slug`  → `x`
 *
 * Catch-all values keep internal slashes (multi-segment). Returns null when the
 * URL is unusable.
 */
export function valueFromEntityUrl(
  url: unknown,
  template: string,
  paramName: string,
): string | null {
  if (typeof url !== "string" || !url) return null;
  let pathname: string;
  try {
    pathname = new URL(url, "https://placeholder.invalid").pathname;
  } catch {
    return null;
  }
  // Drop a trailing slash so it matches the normalized template's static text.
  pathname = pathname.replace(/\/+$/, "");
  const tokens = splitPathTemplate(normalizePagePath(template));
  const idx = tokens.findIndex(
    (t) => t.type === "param" && t.name === paramName,
  );
  if (idx === -1) return null;
  const before = tokens
    .slice(0, idx)
    .map((t) => (t.type === "text" ? t.text : ""))
    .join("");
  const after = tokens
    .slice(idx + 1)
    .map((t) => (t.type === "text" ? t.text : ""))
    .join("");
  // Strip the trailing static text first, then the leading — a shared boundary
  // slash (e.g. `/p` after `/:slug`) must not be consumed twice.
  let rest = pathname;
  if (after && rest.endsWith(after)) {
    rest = rest.slice(0, rest.length - after.length);
  }
  rest =
    before && rest.startsWith(before)
      ? rest.slice(before.length)
      : rest.replace(/^\/+/, "");
  rest = rest.replace(/^\/+|\/+$/g, "");
  return rest ? safeDecode(rest) : null;
}

/**
 * Options from a product-search payload — accepts the schema.org shapes commerce
 * list/search loaders return: a bare `Product[]`, a `ProductListingPage`
 * (`{ products }`), or a `ProductList` (`{ list }`, e.g. the Algolia loader).
 * Items without an extractable value are skipped; duplicate values are deduped.
 * Label prefers `isVariantOf.name`.
 */
export function productOptionsFromPayload(
  data: unknown,
  ctx: OptionPayloadContext,
): PathParamOption[] {
  const rec = asRecord(data);
  const items = Array.isArray(data)
    ? data
    : Array.isArray(rec?.products)
      ? (rec.products as unknown[])
      : Array.isArray(rec?.list)
        ? (rec.list as unknown[])
        : [];
  const options: PathParamOption[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const rec = asRecord(item);
    if (!rec) continue;
    const value = valueFromEntityUrl(rec.url, ctx.template, ctx.paramName);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const variant = asRecord(rec.isVariantOf);
    const label =
      (typeof variant?.name === "string" && variant.name) ||
      (typeof rec.name === "string" && rec.name) ||
      value;
    const imageEntry = Array.isArray(rec.image) ? asRecord(rec.image[0]) : null;
    const image =
      typeof imageEntry?.url === "string" ? imageEntry.url : undefined;
    options.push({ value, label, image });
  }
  return options;
}

/** Category path from a tree node URL: pathname without surrounding slashes. */
function categoryPathFromUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  let pathname: string;
  try {
    pathname = new URL(url, "https://placeholder.invalid").pathname;
  } catch {
    return null;
  }
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  return trimmed ? safeDecode(trimmed) : null;
}

/**
 * Options from a `categories/tree` payload: DFS-flattened, values are the
 * category URL path (multi-segment ok — `fillPathTemplate` keeps `/` in `*`
 * values), labels are `Parent › Child` breadcrumbs. Malformed nodes are
 * tolerated; duplicate paths are deduped.
 */
export function categoryOptionsFromPayload(data: unknown): PathParamOption[] {
  const options: PathParamOption[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, trail: string[]) => {
    const rec = asRecord(node);
    if (!rec) return;
    const name = typeof rec.name === "string" && rec.name ? rec.name : "";
    const nextTrail = name ? [...trail, name] : trail;
    const value = categoryPathFromUrl(rec.url);
    if (value && !seen.has(value)) {
      seen.add(value);
      options.push({ value, label: nextTrail.join(" › ") || value });
    }
    if (Array.isArray(rec.children)) {
      for (const child of rec.children) walk(child, nextTrail);
    }
  };
  if (Array.isArray(data)) {
    for (const node of data) walk(node, []);
  }
  return options;
}

/**
 * Client-side filter for kinds whose full option set is fetched once (the
 * category tree): case-insensitive substring match on label or value, capped
 * so cmdk never renders thousands of rows.
 */
export function filterPickerOptions(
  options: PathParamOption[],
  term: string,
  max = 50,
): PathParamOption[] {
  const query = term.trim().toLowerCase();
  const matched = query
    ? options.filter(
        (option) =>
          option.label.toLowerCase().includes(query) ||
          option.value.toLowerCase().includes(query),
      )
    : options;
  return matched.slice(0, max);
}
