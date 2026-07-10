import {
  normalizePagePath,
  splitPathTemplate,
} from "@/web/components/sections-editor/page-path-utils";

/** Entity kind a path param can be filled from. VTEX-only for now. */
export type PathParamPickerKind = "product" | "category";

export interface PathParamOption {
  /** Committed into the param — never has a leading slash. */
  value: string;
  label: string;
  image?: string;
}

/** Loader each kind invokes — also the manifest-gating key. VTEX-only for now. */
export const PICKER_LOADER_RESOLVE_TYPE: Record<PathParamPickerKind, string> = {
  product: "vtex/loaders/intelligentSearch/productList.ts",
  category: "vtex/loaders/categories/tree.ts",
};

/**
 * Which picker (if any) a param of a path template gets:
 *
 * - the `*` catch-all → "category" (PLP-style pages, e.g. `/*`)
 * - a `:param` immediately followed by a literal `/p` at the END of the
 *   template → "product" (PDP-style pages, e.g. `/:slug/p`)
 * - everything else → null (free typing only)
 */
export function detectPickerKind(
  template: string,
  paramName: string,
): PathParamPickerKind | null {
  const tokens = splitPathTemplate(normalizePagePath(template));
  if (paramName === "*") {
    return tokens.some((t) => t.type === "param" && t.name === "*")
      ? "category"
      : null;
  }
  const last = tokens[tokens.length - 1];
  const prev = tokens[tokens.length - 2];
  return last?.type === "text" &&
    last.text === "/p" &&
    prev?.type === "param" &&
    prev.name === paramName
    ? "product"
    : null;
}

/**
 * Loader call for a kind. Products search server-side per term; the category
 * tree is fetched once (term-independent) and filtered client-side.
 */
export function pickerLoaderRequest(
  kind: PathParamPickerKind,
  term: string,
): { resolveType: string; props: Record<string, unknown> } {
  if (kind === "product") {
    return {
      resolveType: PICKER_LOADER_RESOLVE_TYPE.product,
      props: { query: term, count: 10 },
    };
  }
  return { resolveType: PICKER_LOADER_RESOLVE_TYPE.category, props: {} };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
 * Slug from a product URL: the single pathname segment before the trailing
 * `/p` (e.g. `https://store.com/apple-watch/p` → `apple-watch`). Accepts
 * relative or absolute URLs; null when the shape doesn't match.
 */
export function productSlugFromUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  let pathname: string;
  try {
    pathname = new URL(url, "https://placeholder.invalid").pathname;
  } catch {
    return null;
  }
  const slug = pathname.match(/^\/([^/]+)\/p\/?$/)?.[1];
  return slug ? safeDecode(slug) : null;
}

/**
 * Options from a `productList` payload (`Product[] | null`). Items without an
 * extractable slug are skipped; duplicate slugs are deduped.
 */
export function productOptionsFromPayload(data: unknown): PathParamOption[] {
  if (!Array.isArray(data)) return [];
  const options: PathParamOption[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const rec = asRecord(item);
    if (!rec) continue;
    const slug = productSlugFromUrl(rec.url);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const variant = asRecord(rec.isVariantOf);
    const label =
      (typeof variant?.name === "string" && variant.name) ||
      (typeof rec.name === "string" && rec.name) ||
      slug;
    const imageEntry = Array.isArray(rec.image) ? asRecord(rec.image[0]) : null;
    const image =
      typeof imageEntry?.url === "string" ? imageEntry.url : undefined;
    options.push({ value: slug, label, image });
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
