import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { PublicConfig } from "@decocms/shared/config";
import { KEYS } from "@/lib/query-keys";

async function fetchPublicConfig(): Promise<PublicConfig> {
  const response = await fetch("/api/config");
  const data = await response.json();
  return data.config;
}

/**
 * Returns the cached public config (fetched by ThemeProvider on app init).
 * Must be used inside a Suspense boundary.
 */
export function usePublicConfig(): PublicConfig {
  const { data } = useSuspenseQuery<PublicConfig>({
    queryKey: KEYS.publicConfig(),
    queryFn: fetchPublicConfig,
    staleTime: Infinity,
  });
  return data;
}

/**
 * The same cache entry, without suspending — for leaf components that render
 * outside any Suspense boundary of their own (a message's cost label reads a
 * deployment flag too). `undefined` until app init has filled the cache.
 */
export function usePublicConfigOptional(): PublicConfig | undefined {
  return useQuery<PublicConfig>({
    queryKey: KEYS.publicConfig(),
    queryFn: fetchPublicConfig,
    staleTime: Infinity,
  }).data;
}
