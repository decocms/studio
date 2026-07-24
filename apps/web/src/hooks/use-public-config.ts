import { useSuspenseQuery } from "@tanstack/react-query";
import type { PublicConfig } from "@decocms/shared/config";
import { KEYS } from "@/lib/query-keys";

/**
 * Returns the cached public config (fetched by ThemeProvider on app init).
 * Must be used inside a Suspense boundary.
 */
export function usePublicConfig(): PublicConfig {
  const { data } = useSuspenseQuery<PublicConfig>({
    queryKey: KEYS.publicConfig(),
    queryFn: async () => {
      const response = await fetch("/api/config");
      const data = await response.json();
      return data.config;
    },
    staleTime: Infinity,
  });
  return data;
}

/** Default product logos per color mode */
export const DEFAULT_LOGO = {
  light: "/logos/deco logo.svg",
  dark: "/logos/deco logo negative.svg",
};
