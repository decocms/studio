import { readProductListIds } from "./product-loader-utils";

export interface ResolvedProductPreview {
  id: string;
  sku: string;
  groupId: string;
  name: string;
  imageUrl: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numStr(value: unknown): string {
  return typeof value === "number" ? String(value) : str(value);
}

export function productListLoaderKey(loader: unknown): string {
  const resolveType = str(asRecord(loader)?.__resolveType);
  const ids = readProductListIds(loader).join(",");
  return `${resolveType}|${ids}`;
}

function unwrapProductRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const nested = asRecord(value.product);
  if (!nested) return value;
  return { ...value, ...nested };
}

function extractImageUrl(product: Record<string, unknown>): string | null {
  const nested = asRecord(product.product);
  if (nested) {
    const nestedImage = extractImageUrl(nested);
    if (nestedImage) return nestedImage;
  }

  const direct = str(product.imageUrl) || str(product.thumbnailUrl);
  if (direct) return direct;

  for (const key of ["image", "images"] as const) {
    const value = product[key];
    if (typeof value === "string" && value) return value;
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string" && entry) return entry;
      const obj = asRecord(entry);
      const url = str(obj?.url) || str(obj?.contentUrl);
      if (url) return url;
    }
  }

  return null;
}

function looksLikeEan(value: string): boolean {
  return /^\d{8,14}$/.test(value.trim());
}

/** Prefer human titles; VTEX often puts the EAN/gtin in `name`. */
function firstDisplayName(candidates: string[]): string {
  for (const candidate of candidates) {
    const value = candidate.trim();
    if (!value) continue;
    if (!looksLikeEan(value)) return value;
  }
  return candidates.find((candidate) => candidate.trim())?.trim() ?? "";
}

function extractProductName(product: Record<string, unknown>): string {
  const variantOf = asRecord(product.isVariantOf);
  const nested = asRecord(product.product);
  const nestedVariantOf = nested ? asRecord(nested.isVariantOf) : null;

  return firstDisplayName([
    str(variantOf?.name),
    str(nestedVariantOf?.name),
    str(product.productName),
    nested ? str(nested.productName) : "",
    nested ? str(nested.name) : "",
    str(product.name),
    str(product.alternateName),
    str(asRecord(product.brand)?.name),
  ]);
}

export function parseSingleProduct(
  value: unknown,
): ResolvedProductPreview | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const product = unwrapProductRecord(raw);

  const sku = numStr(product.sku) || numStr(product.productID);
  const groupId = numStr(product.inProductGroupWithID);

  return {
    id: sku || groupId || numStr(product.productId) || str(product["@id"]),
    sku,
    groupId,
    name: extractProductName(product),
    imageUrl: extractImageUrl(product),
  };
}

function parseProductArray(data: unknown[]): (ResolvedProductPreview | null)[] {
  return data.map((entry) =>
    entry == null ? null : parseSingleProduct(entry),
  );
}

export function parseProductListPreview(
  data: unknown,
): (ResolvedProductPreview | null)[] {
  if (Array.isArray(data)) {
    return parseProductArray(data);
  }

  const obj = asRecord(data);
  if (!obj) return [];

  for (const key of [
    "products",
    "product",
    "items",
    "data",
    "result",
  ] as const) {
    const nested = obj[key];
    if (Array.isArray(nested)) {
      return parseProductArray(nested);
    }
    const single = parseSingleProduct(nested);
    if (single) return [single];
  }

  const single = parseSingleProduct(data);
  return single ? [single] : [];
}

function lookupKeys(product: ResolvedProductPreview): string[] {
  return [
    ...new Set([product.id, product.sku, product.groupId].filter(Boolean)),
  ];
}

/** Map loader ids to resolved products, preserving VTEX sort order and sparse slots. */
export function alignProductsToIds(
  ids: string[],
  products: (ResolvedProductPreview | null)[],
): (ResolvedProductPreview | null)[] {
  const trimmed = ids.map((id) => id.trim()).filter(Boolean);
  const byKey = new Map<string, ResolvedProductPreview>();
  for (const product of products) {
    if (!product) continue;
    for (const key of lookupKeys(product)) {
      byKey.set(key, product);
    }
  }

  return trimmed.map((id, index) => byKey.get(id) ?? products[index] ?? null);
}
