import type { PageVariantInfo } from "./variant-matcher-override";

/**
 * Variant previews on a Blocks (v8) site, which has no
 * `x-deco-matchers-override`: the preview's `?__draft=` pointer forces the
 * variant instead. Each forced variant is one reserved `__variant` parameter
 * in the pointer's query, `<block>@<path>=<index>` URL-encoded: the saved
 * block holding the multivariate, the JSON path to it inside that block, and
 * the variant to show. `cms.forDraft` applies them even over the content
 * module, which has no drafts (blocks docs: /next/releases-and-drafts#preview-a-variant).
 */
const FORCED_VARIANT_PARAM = "__variant=";

/** `<block>@<path>=<index>`: one forced variant, as the pointer carries it (before encoding). */
function forcedVariant(block: string, path: string, index: number): string {
  return `${block}@${path}=${index}`;
}

/** Force the active *page* variant: the multivariate is the page's `sections`. */
export function buildPageForcedVariants(
  pageKey: string,
  page: PageVariantInfo,
): string[] {
  if (!pageKey || !page.multivariate || page.variants.length <= 1) return [];
  if (page.index < 0 || page.index >= page.variants.length) return [];
  return [forcedVariant(pageKey, "sections", page.index)];
}

/**
 * Force the selected *section* variant. The path is the stored JSON path to
 * the multivariate: inside the active page variant's list when the page has
 * variants, and inside the Lazy wrapper's `section` when it has one.
 */
export function buildSectionForcedVariants(args: {
  pageKey: string;
  page: PageVariantInfo;
  sectionIndex: number;
  sectionLazy: boolean;
  mvObj: Record<string, unknown>;
  selectedVariantIndex: number;
}): string[] {
  const variants = Array.isArray(args.mvObj.variants)
    ? args.mvObj.variants
    : [];
  if (!args.pageKey || args.sectionIndex < 0) return [];
  if (
    args.selectedVariantIndex < 0 ||
    args.selectedVariantIndex >= variants.length
  ) {
    return [];
  }
  const base = args.page.multivariate
    ? `sections.variants.${args.page.index}.value`
    : "sections";
  const path = `${base}.${args.sectionIndex}${args.sectionLazy ? ".section" : ""}`;
  return [forcedVariant(args.pageKey, path, args.selectedVariantIndex)];
}

/** encodeURIComponent, plus the characters it leaves that a pointer's path doesn't allow. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The pointer (`<host><path[?query]>@<version>`) with exactly these forced
 * variants: any it already carried are replaced.
 */
export function withForcedVariants(pointer: string, forced: string[]): string {
  const at = pointer.lastIndexOf("@");
  if (at <= 0) return pointer;
  const location = pointer.slice(0, at);
  const q = location.indexOf("?");
  const base = q === -1 ? location : location.slice(0, q);
  const kept =
    q === -1
      ? []
      : location
          .slice(q + 1)
          .split("&")
          .filter((param) => param && !param.startsWith(FORCED_VARIANT_PARAM));
  const params = [
    ...kept,
    ...forced.map((entry) => FORCED_VARIANT_PARAM + encode(entry)),
  ];
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  return `${base}${query}${pointer.slice(at)}`;
}

/**
 * A pointer to a connected `deco serve` that forces these variants. The site
 * reads its content module, which ignores the rest of the pointer; the token
 * never goes in it. `null` when nothing is forced or the endpoint is no URL.
 */
export function buildServeDraftPointer(
  endpoint: string,
  forced: string[],
): string | null {
  if (forced.length === 0) return null;
  try {
    const url = new URL(endpoint);
    // A pointer's host is a DNS name; `[::1]` is the same machine.
    const host =
      url.hostname === "[::1]"
        ? `localhost${url.port ? `:${url.port}` : ""}`
        : url.host;
    return withForcedVariants(`${host}${url.pathname}@local`, forced);
  } catch {
    return null;
  }
}

/**
 * A site URL whose `?__draft=` pointer carries these forced variants. A URL
 * without a pointer, or asking for the published render (`off`), stays as is.
 */
export function withForcedVariantsInDraftUrl(
  href: string,
  forced: string[],
): string {
  if (forced.length === 0) return href;
  try {
    const url = new URL(href);
    const pointer = url.searchParams.get("__draft");
    if (!pointer || pointer === "off") return href;
    url.searchParams.set("__draft", withForcedVariants(pointer, forced));
    return url.toString();
  } catch {
    return href;
  }
}
