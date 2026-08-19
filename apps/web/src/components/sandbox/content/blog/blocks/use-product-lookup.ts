import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import {
  buildPreviewInvokePath,
  type PreviewProxyRef,
} from "@/components/sections-editor/preview-fetch-url";
import {
  buildProductsByIdsRequest,
  type PickerLoaderRequest,
  productOptionsFromPayload,
  type ProductPickerOption,
} from "./product-picker-source";

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Invoke a loader through the Studio preview-invoke proxy (same-origin,
 * authenticated) — the route useRunBlock and the product picker share. Hitting
 * the preview origin directly would fail CORS on `/deco/invoke`.
 */
export async function invokeLoader(
  ref: PreviewProxyRef,
  { resolveType, props }: PickerLoaderRequest,
): Promise<unknown> {
  const res = await fetch(buildPreviewInvokePath(ref), {
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
 * Resolve the shelf/card's stored SKU ids back to products so the editor can
 * render thumbnails + names. One batched `productList` invoke; the result is
 * keyed by id (the caller preserves the stored order). Disabled when there's
 * no running sandbox or no ids.
 */
export function useProductsByIds(
  sandboxRef: PreviewProxyRef | null | undefined,
  ids: string[],
): ProductLookup {
  const clean = [...new Set(ids.filter(Boolean))];
  const query = useQuery({
    queryKey: KEYS.sandboxInvoke(
      sandboxRef
        ? `${sandboxRef.orgSlug}/${sandboxRef.virtualMcpId}/${sandboxRef.branch}`
        : "none",
      `blog-products-by-ids:${clean.join(",")}`,
    ),
    queryFn: () =>
      invokeLoader(sandboxRef!, buildProductsByIdsRequest(clean)).then(
        productOptionsFromPayload,
      ),
    enabled: !!sandboxRef && clean.length > 0,
    staleTime: 60_000,
    retry: 1,
  });

  const byId = new Map<string, ProductPickerOption>();
  for (const option of query.data ?? []) byId.set(option.id, option);

  return { byId, isLoading: query.isLoading, isError: query.isError };
}
