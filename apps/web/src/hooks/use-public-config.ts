import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { PublicConfig } from "@decocms/shared/config";
import { KEYS } from "@/lib/query-keys";

/**
 * Finite, not Infinity: this query is hydrated from localStorage before React
 * mounts (see `lib/query-persist.ts`), and an Infinity staleTime meant the
 * hydrated entry never revalidated — a deployment flag added or flipped
 * server-side stayed invisible to an existing browser until the 24h expiry or
 * the next `__STUDIO_VERSION__` bump. Hydration still paints instantly; this
 * only restores the background refetch that query-persist already documents.
 */
export const PUBLIC_CONFIG_STALE_TIME_MS = 5 * 60_000;

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
    staleTime: PUBLIC_CONFIG_STALE_TIME_MS,
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
    staleTime: PUBLIC_CONFIG_STALE_TIME_MS,
  }).data;
}
