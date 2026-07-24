import { useQuery } from "@tanstack/react-query";
import {
  buildAppCatalog,
  type AppCatalogEntry,
  type DecoStoreApp,
} from "@/components/sandbox/content/app-catalog";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { KEYS } from "@/lib/query-keys";

async function fetchDecoStoreApps(): Promise<DecoStoreApp[]> {
  const res = await fetch("/api/deco-apps");
  if (!res.ok) {
    throw new Error(`Failed to fetch deco apps: ${res.status}`);
  }
  const data = (await res.json()) as { apps?: DecoStoreApp[] };
  return data.apps ?? [];
}

export function useDecoAppsCatalog(
  meta: LiveMeta | undefined,
  decofile: Record<string, unknown> | undefined,
  options?: { enabled?: boolean },
) {
  const enabled = options?.enabled ?? true;
  const storeQuery = useQuery({
    queryKey: KEYS.decoApps(),
    queryFn: fetchDecoStoreApps,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    enabled,
  });

  const catalog: AppCatalogEntry[] =
    meta && decofile
      ? buildAppCatalog(storeQuery.data ?? [], meta, decofile)
      : [];

  return {
    catalog,
    isLoading: storeQuery.isLoading && !storeQuery.isError,
    isError: storeQuery.isError,
    refetch: storeQuery.refetch,
  };
}
