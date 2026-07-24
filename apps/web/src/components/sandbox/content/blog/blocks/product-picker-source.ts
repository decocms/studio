/**
 * VTEX-only product discovery for the blog ProductShelf/ProductCard editors.
 *
 * These blocks store a flat list of SKU ids (see product-loader-utils). The
 * picker is purely a *discovery* tool: whatever the user browses to — a free
 * search, a category, or a collection/cluster — is resolved to concrete
 * products via the VTEX intelligent-search loader, and only the ids the user
 * checks are written back. The section keeps receiving `Product[]`.
 *
 * VTEX-only is intentional for now (mirrors the preview path-param picker's
 * original hardcoded approach): the two loader resolveTypes below are the only
 * backend assumption. Credentials/account live in the running site's VTEX app,
 * never here — we only invoke loaders by resolveType through the Studio proxy.
 */

export const VTEX_PRODUCT_LIST_RESOLVE_TYPE =
  "vtex/loaders/intelligentSearch/productList.ts";
export const VTEX_CATEGORY_TREE_RESOLVE_TYPE =
  "vtex/loaders/categories/tree.ts";

/** How the user is currently narrowing the product results. */
export type ProductPickerMode = "search" | "category" | "cluster";

/** A product surfaced in the picker, ready to be toggled into the shelf. */
export interface ProductPickerOption {
  /** SKU id — the value stored in the block's `ids`. */
  id: string;
  label: string;
  image?: string;
}

/** A category surfaced by the tree loader, selectable to filter products. */
export interface CategoryOption {
  /** Category path, e.g. `moda-feminina/calcados`. */
  path: string;
  /** `Parent › Child` breadcrumb for display. */
  label: string;
}

/** A single loader invoke: resolveType + the flat props the loader receives. */
export interface PickerLoaderRequest {
  resolveType: string;
  props: Record<string, unknown>;
}

/** Default page size when browsing products — a shelf shows a handful. */
export const PRODUCT_PICKER_COUNT = 24;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Convert a category tree path into VTEX intelligent-search facets. Each path
 * segment becomes a `category-N/<slug>` pair (1-indexed by depth), joined with
 * `/` — the `facets` string the productList loader's FacetsProps expects
 * (e.g. `moda/calcados` → `category-1/moda/category-2/calcados`).
 */
export function categoryPathToFacets(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.map((seg, i) => `category-${i + 1}/${seg}`).join("/");
}

/**
 * Build the productList requests for the current mode + term. A search term
 * fans out: a numeric term also tries the `ids` variant (exact SKU match),
 * slug-like terms are de-hyphenated so their words match the product name.
 * Category/cluster take a single request. An empty/blank term yields no
 * requests (the picker shows nothing until the user narrows).
 */
export function buildProductRequests(
  mode: ProductPickerMode,
  term: string,
): PickerLoaderRequest[] {
  const trimmed = term.trim();
  if (!trimmed) return [];

  const resolveType = VTEX_PRODUCT_LIST_RESOLVE_TYPE;
  const count = PRODUCT_PICKER_COUNT;

  if (mode === "cluster") {
    return [{ resolveType, props: { collection: trimmed, count } }];
  }
  if (mode === "category") {
    const facets = categoryPathToFacets(trimmed);
    if (!facets) return [];
    return [{ resolveType, props: { facets, count } }];
  }

  // mode === "search"
  const requests: PickerLoaderRequest[] = [];
  if (/^\d+$/.test(trimmed)) {
    requests.push({ resolveType, props: { ids: [trimmed] } });
  }
  const slugLike = trimmed.includes("-") && !/\s/.test(trimmed);
  const query = slugLike ? trimmed.replace(/-+/g, " ") : trimmed;
  requests.push({ resolveType, props: { query, count } });
  return requests;
}

/** The category tree is term-independent — fetched once, filtered client-side. */
export function buildCategoryTreeRequest(): PickerLoaderRequest {
  return { resolveType: VTEX_CATEGORY_TREE_RESOLVE_TYPE, props: {} };
}

/**
 * Resolve a set of already-selected SKU ids back to products — used to render
 * the shelf/card editor as rich product cards (thumbnail + name) instead of
 * raw id inputs.
 */
export function buildProductsByIdsRequest(ids: string[]): PickerLoaderRequest {
  return { resolveType: VTEX_PRODUCT_LIST_RESOLVE_TYPE, props: { ids } };
}

function idString(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

/**
 * Map a productList payload to picker options. Accepts the schema.org shapes
 * VTEX search returns — a bare `Product[]` or a `ProductListingPage`
 * (`{ products }`). The stored id is the SKU (`productID`, the same value the
 * `ids` prop retrieves); items without one are skipped and duplicates deduped.
 * Label prefers `isVariantOf.name`, image is the first `image[].url`.
 */
export function productOptionsFromPayload(
  data: unknown,
): ProductPickerOption[] {
  const rec = asRecord(data);
  const items = Array.isArray(data)
    ? data
    : Array.isArray(rec?.products)
      ? (rec.products as unknown[])
      : [];
  const options: ProductPickerOption[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const product = asRecord(item);
    if (!product) continue;
    const id = idString(product.productID) || idString(product.sku);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const variant = asRecord(product.isVariantOf);
    const label =
      (typeof variant?.name === "string" && variant.name) ||
      (typeof product.name === "string" && product.name) ||
      id;
    const imageEntry = Array.isArray(product.image)
      ? asRecord(product.image[0])
      : null;
    const image =
      typeof imageEntry?.url === "string" ? imageEntry.url : undefined;
    options.push({ id, label, image });
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
  return trimmed || null;
}

/**
 * Flatten a `categories/tree` payload (DFS) into selectable options. Values are
 * the category URL path (multi-segment for nested categories), labels are
 * `Parent › Child` breadcrumbs. Malformed nodes are tolerated; duplicate paths
 * are deduped.
 */
export function categoryOptionsFromPayload(data: unknown): CategoryOption[] {
  const options: CategoryOption[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, trail: string[]) => {
    const rec = asRecord(node);
    if (!rec) return;
    const name = typeof rec.name === "string" && rec.name ? rec.name : "";
    const nextTrail = name ? [...trail, name] : trail;
    const path = categoryPathFromUrl(rec.url);
    if (path && !seen.has(path)) {
      seen.add(path);
      options.push({ path, label: nextTrail.join(" › ") || path });
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
 * Case-insensitive substring filter over category options (label or path),
 * capped so the command list never renders thousands of rows.
 */
export function filterCategoryOptions(
  options: CategoryOption[],
  term: string,
  max = 50,
): CategoryOption[] {
  const query = term.trim().toLowerCase();
  const matched = query
    ? options.filter(
        (option) =>
          option.label.toLowerCase().includes(query) ||
          option.path.toLowerCase().includes(query),
      )
    : options;
  return matched.slice(0, max);
}
