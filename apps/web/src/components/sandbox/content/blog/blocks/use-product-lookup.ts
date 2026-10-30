import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import {
  buildCatalogInvokePath,
  type PreviewProxyRef,
} from "@/components/sections-editor/preview-fetch-url";
import type {
  PickerLoaderRequest,
  ProductPickerOption,
} from "./product-picker-source";
import type { CatalogSource } from "./catalog-source";

const FETCH_TIMEOUT_MS = 10_000;

/** Invoke a catalog loader through the sandbox-optional catalog-invoke proxy. */
export async function invokeLoader(
  ref: PreviewProxyRef,
  { resolveType, props }: PickerLoaderRequest,
): Promise<unknown> {
  const res = await fetch(buildCatalogInvokePath(ref), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ __resolveType: resolveType, ...props }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Failed to fetch (${res.status})`);
  return res.json();
}

export interface ProductLookup {
  /** Resolved products keyed by SKU id — misses stay absent (show a fallback). */
  byId: Map<string, ProductPickerOption>;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Resolve stored SKU ids back to products so an editor can render thumbnails
 * and names, keyed by id (the caller preserves the stored order). Disabled
 * when there is no catalog to ask or no ids.
 */
export function useProductsByIds(
  source: CatalogSource | null | undefined,
  ids: string[],
): ProductLookup {
  const clean = [...new Set(ids.filter(Boolean))];
  const query = useQuery({
    queryKey: KEYS.sandboxInvoke(
      source?.key ?? "none",
      `blog-products-by-ids:${clean.join(",")}`,
    ),
    queryFn: () => source!.productsByIds(clean),
    enabled: !!source && clean.length > 0,
    staleTime: 60_000,
    retry: 1,
  });

  const byId = new Map<string, ProductPickerOption>();
  for (const option of query.data ?? []) byId.set(option.id, option);

  return { byId, isLoading: query.isLoading, isError: query.isError };
}
