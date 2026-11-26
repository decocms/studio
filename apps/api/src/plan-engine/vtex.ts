/**
 * The store's public VTEX catalog, read over plain HTTP from its own domain:
 * no credentials, so a failure here is the store's or VTEX's, never the
 * customer's to fix.
 */

import { RetryError, retry } from "@decocms/shared/std";

/** The store's domain; its `catalog_system/pub` routes answer without a key. */
export interface VtexAccess {
  publicHost: string;
}

export interface VtexCatalogSearchProduct {
  productId: string;
  productName: string;
  /** URL slug of the PDP. */
  linkText?: string;
  /** One SKU per size; `commertialOffer` carries the stock. */
  items?: {
    itemId?: string;
    sellers?: {
      commertialOffer?: {
        IsAvailable?: boolean;
        AvailableQuantity?: number;
      };
    }[];
  }[];
}

const TIMEOUT_MS = 30_000;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

class VtexHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "VtexHttpError";
  }
}

/** Transient statuses and network/timeout failures are worth another try. */
const isRetriable = (err: unknown) =>
  err instanceof VtexHttpError
    ? RETRYABLE_STATUSES.has(err.status)
    : (err instanceof DOMException &&
        (err.name === "AbortError" || err.name === "TimeoutError")) ||
      err instanceof TypeError;

/** GET a public catalog route; a transient failure is tried again. */
async function vtexGet(
  access: VtexAccess,
  path: string,
  fetchImpl: typeof fetch,
): Promise<VtexCatalogSearchProduct[]> {
  const url = `https://${access.publicHost}${path}`;
  try {
    return await retry(
      async () => {
        const response = await fetchImpl(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          const snippet = text.slice(0, 300).replace(/\s+/g, " ").trim();
          throw new VtexHttpError(
            `VTEX GET ${path} → HTTP ${response.status}${snippet ? ` body="${snippet}"` : ""}`,
            response.status,
          );
        }
        const body = await response.text();
        return body ? (JSON.parse(body) as VtexCatalogSearchProduct[]) : [];
      },
      { maxAttempts: 4, minTimeout: 500, maxTimeout: 8_000, isRetriable },
    );
  } catch (err) {
    throw err instanceof RetryError ? err.cause : err;
  }
}

/**
 * Full search payloads for known product ids, in one call: `fq=productId:`
 * repeats as an OR.
 */
export async function vtexSearchByProductIds(
  access: VtexAccess,
  productIds: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<VtexCatalogSearchProduct[]> {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const fq = ids
    .map((id) => `fq=productId:${encodeURIComponent(id)}`)
    .join("&");
  return vtexGet(
    access,
    `/api/catalog_system/pub/products/search?${fq}&_from=0&_to=${Math.max(0, ids.length - 1)}`,
    fetchImpl,
  );
}

/** Catalog search by term (empty = any product); `linkText` builds the PDP link. */
export async function vtexCatalogSearch(
  access: VtexAccess,
  term: string,
  opts: { from?: number; to?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<VtexCatalogSearchProduct[]> {
  return vtexGet(
    access,
    `/api/catalog_system/pub/products/search/${encodeURIComponent(term)}?_from=${opts.from ?? 0}&_to=${opts.to ?? 9}`,
    fetchImpl,
  );
}

/** `unknown` is a payload that never carried stock, not a sold-out one. */
type AvailabilityState = "alive" | "sold_out" | "unknown";

interface AvailabilitySummary {
  /** SKUs (sizes) present in the payload. */
  totalSkus: number;
  /** SKUs with at least one seller reporting `IsAvailable`. */
  availableSkus: number;
  state: AvailabilityState;
}

/** Stock off a search payload: a SKU is available when any seller says so. */
export function readAvailability(
  p: VtexCatalogSearchProduct | null | undefined,
): AvailabilitySummary {
  const items = Array.isArray(p?.items) ? p.items : null;
  if (!items || items.length === 0) {
    return { totalSkus: 0, availableSkus: 0, state: "unknown" };
  }
  let totalSkus = 0;
  let availableSkus = 0;
  // "Every seller said false" differs from "no seller said anything".
  let sawSignal = false;
  for (const item of items) {
    totalSkus += 1;
    const sellers = Array.isArray(item?.sellers) ? item.sellers : [];
    let itemAvailable = false;
    for (const seller of sellers) {
      const offer = seller?.commertialOffer;
      if (!offer || typeof offer.IsAvailable !== "boolean") continue;
      sawSignal = true;
      if (offer.IsAvailable) itemAvailable = true;
    }
    if (itemAvailable) availableSkus += 1;
  }
  if (!sawSignal) return { totalSkus, availableSkus: 0, state: "unknown" };
  return {
    totalSkus,
    availableSkus,
    state: availableSkus > 0 ? "alive" : "sold_out",
  };
}
