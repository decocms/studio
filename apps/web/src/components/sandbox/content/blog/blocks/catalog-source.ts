/**
 * Where a picker reads the store's catalog from.
 *
 * The post editor reads through the running site's own loaders, so what it
 * shows is what the published block will render. The organization's campaigns
 * have no site to ask, and read through its VTEX connection instead
 * (`vtex-mcp-source.ts`). Both answer in the picker's own shapes, and both
 * store the SKU id a product block resolves.
 */

import type { PreviewProxyRef } from "@/components/sections-editor/preview-fetch-url";
import {
  buildCategoryTreeRequest,
  buildProductRequests,
  buildProductsByIdsRequest,
  type CategoryOption,
  categoryOptionsFromPayload,
  type PickerLoaderRequest,
  productOptionsFromPayload,
  type ProductPickerMode,
  type ProductPickerOption,
} from "./product-picker-source";
import { invokeLoader } from "./use-product-lookup";

export interface CatalogSource {
  /** Tells one source's cached answers from another's. */
  key: string;
  /** Whether a mode and term would ask the store anything at all. */
  canSearch: (mode: ProductPickerMode, term: string) => boolean;
  searchProducts: (
    mode: ProductPickerMode,
    term: string,
  ) => Promise<ProductPickerOption[]>;
  categoryTree: () => Promise<CategoryOption[]>;
  /** The products behind stored SKU ids; a miss is simply absent. */
  productsByIds: (ids: string[]) => Promise<ProductPickerOption[]>;
}

/**
 * Run several reads for one term in parallel and merge them in order, deduped
 * by id. Tolerates partial failure as long as one read succeeds.
 */
export async function mergeProductReads(
  reads: Promise<ProductPickerOption[]>[],
): Promise<ProductPickerOption[]> {
  if (reads.length === 0) return [];
  const settled = await Promise.allSettled(reads);
  const fulfilled = settled.filter(
    (s): s is PromiseFulfilledResult<ProductPickerOption[]> =>
      s.status === "fulfilled",
  );
  if (fulfilled.length === 0) {
    const failed = settled.find(
      (s): s is PromiseRejectedResult => s.status === "rejected",
    );
    throw failed ? failed.reason : new Error("Failed to fetch products");
  }
  const merged: ProductPickerOption[] = [];
  const seen = new Set<string>();
  for (const { value } of fulfilled) {
    for (const option of value) {
      if (seen.has(option.id)) continue;
      seen.add(option.id);
      merged.push(option);
    }
  }
  return merged;
}

/** The running site's catalog loaders, through the sandbox's invoke proxy. */
export function loaderCatalogSource(ref: PreviewProxyRef): CatalogSource {
  const read = (request: PickerLoaderRequest) =>
    invokeLoader(ref, request).then(productOptionsFromPayload);
  return {
    key: `loader:${ref.orgSlug}/${ref.virtualMcpId}/${ref.branch}`,
    canSearch: (mode, term) => buildProductRequests(mode, term).length > 0,
    searchProducts: (mode, term) =>
      mergeProductReads(buildProductRequests(mode, term).map(read)),
    categoryTree: () =>
      invokeLoader(ref, buildCategoryTreeRequest()).then(
        categoryOptionsFromPayload,
      ),
    productsByIds: (ids) => read(buildProductsByIdsRequest(ids)),
  };
}
