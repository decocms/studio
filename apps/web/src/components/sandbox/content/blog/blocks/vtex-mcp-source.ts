/**
 * The store's catalog, read through the organization's VTEX connection.
 *
 * Campaigns belong to the organization, so there is no running site whose
 * loaders could answer; the VTEX MCP can. Its payloads are VTEX's own —
 * Intelligent Search products and the catalog's SKU context — mapped here to
 * the picker's shapes. The id kept is the SKU id, the one a published product
 * block resolves, so a campaign's products and a post's shelf agree.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { useMCPClientNonBlocking, useProjectContext } from "@/sdk";
import { type CatalogSource, mergeProductReads } from "./catalog-source";
import {
  type CategoryOption,
  categoryOptionsFromPayload,
  categoryPathToFacets,
  type ProductPickerMode,
  type ProductPickerOption,
} from "./product-picker-source";

const SEARCH_COUNT = 24;
/** How deep the category tree is read: department, category, subcategory. */
const CATEGORY_LEVELS = "3";
/** Lookups by id run a few at a time; a campaign rarely holds more than a dozen. */
const LOOKUP_CONCURRENCY = 4;
const MAX_LOOKUP_IDS = 50;

type Call = (name: string, args: Record<string, unknown>) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function shortDescription(raw: unknown): string | undefined {
  const plain = text(raw)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  return plain.length > 400 ? `${plain.slice(0, 400).trimEnd()}…` : plain;
}

/** `/Móveis/Sofás/` → `Sofás`: the leaf is what a writer calls the product. */
function leafCategory(path: unknown): string | undefined {
  const leaf = text(path).split("/").filter(Boolean).pop();
  return leaf || undefined;
}

function unique(urls: string[]): string[] {
  return [...new Set(urls.filter(Boolean))];
}

/**
 * Intelligent Search's `{ products }` as picker options. A product's first SKU
 * stands for it — the picker stores one id per product — and its images are
 * that SKU's.
 */
export function productOptionsFromSearch(data: unknown): ProductPickerOption[] {
  const products = asRecord(data)?.products;
  if (!Array.isArray(products)) return [];
  const options: ProductPickerOption[] = [];
  const seen = new Set<string>();
  for (const entry of products) {
    const product = asRecord(entry);
    if (!product) continue;
    const items = Array.isArray(product.items) ? product.items : [];
    const sku = asRecord(items[0]);
    const id = text(sku?.itemId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const images = unique(
      (Array.isArray(sku?.images) ? sku.images : []).map((image) =>
        text(asRecord(image)?.imageUrl),
      ),
    );
    const linkText = text(product.linkText);
    const categories = Array.isArray(product.categories)
      ? product.categories
      : [];
    options.push({
      id,
      groupId: text(product.productId) || undefined,
      label: text(product.productName) || text(sku?.name) || id,
      image: images[0],
      images,
      url: text(product.link) || (linkText ? `/${linkText}/p` : undefined),
      category: leafCategory(categories[0]),
      description: shortDescription(product.description),
    });
  }
  return options;
}

/** The catalog's SKU context as a picker option, or null for a miss. */
export function productOptionFromSku(
  data: unknown,
): ProductPickerOption | null {
  const sku = asRecord(data);
  const id = text(sku?.Id);
  if (!sku || !id) return null;
  const images = unique(
    (Array.isArray(sku.Images) ? sku.Images : []).map((image) =>
      text(asRecord(image)?.ImageUrl),
    ),
  );
  const categories = asRecord(sku.ProductCategories);
  const category = categories ? text(Object.values(categories).at(-1)) : "";
  return {
    id,
    groupId: text(sku.ProductId) || undefined,
    label: text(sku.ProductName) || text(sku.NameComplete) || id,
    image: images[0],
    images,
    url: text(sku.DetailUrl) || undefined,
    category: category || undefined,
    description: shortDescription(sku.ProductDescription),
  };
}

/** The Intelligent Search reads for one mode and term. */
export function searchArgs(
  mode: ProductPickerMode,
  term: string,
): Record<string, unknown>[] {
  const trimmed = term.trim();
  const count = SEARCH_COUNT;
  if (mode === "cluster") {
    return trimmed ? [{ facets: `productClusterIds/${trimmed}`, count }] : [];
  }
  if (mode === "category") {
    const facets = trimmed ? categoryPathToFacets(trimmed) : "";
    return facets ? [{ facets, count }] : [];
  }
  if (!trimmed) return [{ facets: "/", count }];
  const reads: Record<string, unknown>[] = [];
  if (/^\d+$/.test(trimmed)) {
    reads.push({ facets: "/", query: `sku.id:${trimmed}`, count });
  }
  reads.push({ facets: "/", query: trimmed, count });
  return reads;
}

/** Run `work` over `items`, at most `limit` at a time, keeping order. */
async function inBatches<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(work))));
  }
  return out;
}

export function vtexMcpCatalogSource(key: string, call: Call): CatalogSource {
  return {
    key: `vtex-mcp:${key}`,
    canSearch: (mode, term) => searchArgs(mode, term).length > 0,
    searchProducts: (mode, term) =>
      mergeProductReads(
        searchArgs(mode, term).map((args) =>
          call("VTEX_IS_GET_PRODUCT_SEARCH", args).then(
            productOptionsFromSearch,
          ),
        ),
      ),
    categoryTree: async (): Promise<CategoryOption[]> =>
      categoryOptionsFromPayload(
        await call("VTEX_LIST_CATEGORIES", {
          categoryLevels: CATEGORY_LEVELS,
        }),
      ),
    productsByIds: async (ids) => {
      const found = await inBatches(
        ids.slice(0, MAX_LOOKUP_IDS),
        LOOKUP_CONCURRENCY,
        (id) =>
          call("VTEX_GET_SKU", { skuId: id })
            .then(productOptionFromSku)
            .catch(() => null),
      );
      return found.filter((option): option is ProductPickerOption => !!option);
    },
  };
}

/** A tool's answer: its structured content, else its text parsed as JSON. */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const content = Array.isArray(result.content) ? result.content : [];
    const message = content
      .map((part) => text(asRecord(part)?.text))
      .join(" ")
      .trim();
    throw new Error(message || `${name} failed`);
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const first = Array.isArray(result.content)
    ? asRecord(result.content[0])
    : null;
  const raw = text(first?.text);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** The organization's VTEX catalog, or null with no connection to ask. */
export function useVtexCatalogSource(
  connectionId: string | null,
): CatalogSource | null {
  const { org } = useProjectContext();
  const client = useMCPClientNonBlocking(
    { connectionId: connectionId ?? "", orgId: org.id, orgSlug: org.slug },
    { enabled: !!connectionId },
  );
  if (!connectionId || !client) return null;
  return vtexMcpCatalogSource(`${org.id}/${connectionId}`, (name, args) =>
    callTool(client, name, args),
  );
}
