/**
 * The store's own catalog, as evidence for the brand profile.
 *
 * What a shop sells, under what names, in what price band, is what grounds
 * keywords and differentiators — none of which a site states about itself in
 * prose. The category tree gives the taxonomy; a page of products gives the
 * naming conventions and the price positioning.
 *
 * Read through the same `catalog-invoke` proxy the product picker uses, so the
 * VTEX account and credentials stay in the running site's own app and never
 * reach Studio. VTEX-only for the same reason the picker is: those two loader
 * resolveTypes are the entire backend assumption, and they are the only two the
 * proxy allows.
 */

import { CATALOG_EVIDENCE_MAX_CHARS } from "@decocms/shared/blog-brand-evidence";
import type { PreviewProxyRef } from "@/components/sections-editor/preview-fetch-url";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { manifestLoaderResolveTypes } from "@/components/sandbox/content/runnable-catalog";
import { invokeLoader } from "./use-product-lookup";
import {
  buildCategoryTreeRequest,
  buildProductRequests,
  categoryOptionsFromPayload,
  VTEX_CATEGORY_TREE_RESOLVE_TYPE,
  VTEX_PRODUCT_LIST_RESOLVE_TYPE,
} from "./product-picker-source";

/** Category lines kept — a deep tree runs to thousands and says little more. */
const MAX_CATEGORY_LINES = 120;

/** The whole read races this: a click must not wait on a slow storefront. */
const CATALOG_TIMEOUT_MS = 6_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Whether this site can answer a catalog read at all: it has to ship the two
 * VTEX loaders, since the proxy rejects every other resolveType with a 403.
 * Checked before asking, so a Shopify or headless store costs no round trip.
 */
export function hasVtexCatalog(meta: LiveMeta): boolean {
  const loaders = manifestLoaderResolveTypes(meta, "loaders");
  return (
    loaders.has(VTEX_PRODUCT_LIST_RESOLVE_TYPE) &&
    loaders.has(VTEX_CATEGORY_TREE_RESOLVE_TYPE)
  );
}

/** First price found on a schema.org offer bag, as a plain number. */
function priceOf(product: Record<string, unknown>): number | null {
  const offers = asRecord(product.offers);
  if (!offers) return null;
  const low = offers.lowPrice;
  if (typeof low === "number") return low;
  const first = Array.isArray(offers.offers)
    ? asRecord(offers.offers[0])
    : null;
  const price = first?.price;
  return typeof price === "number" ? price : null;
}

/**
 * Product lines as `name — brand — price — category`.
 *
 * Deliberately not `productOptionsFromPayload`: that one is typed for the
 * picker (id, label, image, url) and must not grow a price it has no use for.
 * Here the id and the image are the useless half. A missing field drops from
 * the line rather than dropping the product.
 */
export function catalogProductLines(payload: unknown): string[] {
  const rec = asRecord(payload);
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(rec?.products)
      ? (rec.products as unknown[])
      : [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const product = asRecord(item);
    if (!product) continue;
    const variant = asRecord(product.isVariantOf);
    const name = str(variant?.name) || str(product.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const price = priceOf(product);
    const parts = [
      name,
      str(asRecord(product.brand)?.name),
      price === null ? "" : price.toFixed(2),
      str(product.category),
    ].filter(Boolean);
    lines.push(`- ${parts.join(" — ")}`);
  }
  return lines;
}

async function readCatalog(ref: PreviewProxyRef): Promise<string> {
  const productRequest = buildProductRequests("search", "")[0] ?? {
    resolveType: VTEX_PRODUCT_LIST_RESOLVE_TYPE,
    props: {},
  };
  const [tree, products] = await Promise.allSettled([
    invokeLoader(ref, buildCategoryTreeRequest()),
    invokeLoader(ref, productRequest),
  ]);

  const sections: string[] = [];

  if (tree.status === "fulfilled") {
    const lines = categoryOptionsFromPayload(tree.value)
      .slice(0, MAX_CATEGORY_LINES)
      .map((category) => `- ${category.label} (${category.path})`);
    if (lines.length) sections.push(`## Category tree\n${lines.join("\n")}`);
  }

  if (products.status === "fulfilled") {
    const lines = catalogProductLines(products.value);
    if (lines.length) {
      sections.push(`## Product sample (default listing)\n${lines.join("\n")}`);
    }
  }

  return sections.join("\n\n").slice(0, CATALOG_EVIDENCE_MAX_CHARS);
}

/**
 * The catalog sample, or `""` when there isn't one.
 *
 * Never throws and never reports: the person clicked "fill my brand context",
 * not "read my catalog", so a storefront that is down, not VTEX, or answering
 * a 403 just means this evidence is absent — which the tool input already
 * allows. Racing the timeout matters because the proxy's own limit is 30s,
 * long enough to make the click feel broken.
 */
export function fetchCatalogEvidence(ref: PreviewProxyRef): Promise<string> {
  return Promise.race([
    readCatalog(ref),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve(""), CATALOG_TIMEOUT_MS),
    ),
  ]).catch(() => "");
}
