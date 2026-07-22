import { Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setCollectionToastTranslations } from "@decocms/mesh-sdk";

import { AuthConfigProvider } from "@/web/providers/auth-config-provider";
import { BetterAuthUIProvider } from "@/web/providers/better-auth-ui-provider";
import { PostHogIdentitySync } from "@/web/providers/posthog-provider";
import { SplashScreen } from "@/web/components/splash-screen";
import { ThemeProvider } from "@/web/providers/theme-provider";
import {
  hydrateQueryClient,
  persistQueryClient,
} from "@/web/lib/query-persist";
import {
  persistHtmlResourceCache,
  restoreHtmlResourceCache,
} from "@/web/lib/html-resource-persist";
import { Toaster } from "sonner";
import { useT } from "@/web/i18n/use-t";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data is fresh for 1 minute by default
      staleTime: 60_000,
      // Only refetch on window focus if data is stale (respects staleTime)
      refetchOnWindowFocus: true,
      // Don't refetch on mount if data is still fresh
      refetchOnMount: true,
      // Retry failed requests (but not too aggressively)
      retry: 1,
      // Keep unused data in cache for 5 minutes
      gcTime: 5 * 60 * 1000,
    },
  },
});

hydrateQueryClient(queryClient);
persistQueryClient(queryClient);
// Large UI-resource HTML goes to IndexedDB (not the localStorage cache above):
// warm-start from it, then keep it written on successful reads.
void restoreHtmlResourceCache(queryClient);
persistHtmlResourceCache(queryClient);

function SdkTranslationInitializer({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useT();

  setCollectionToastTranslations({
    itemCreatedSuccessfully: t("collections.mutations.itemCreatedSuccessfully"),
    itemUpdatedSuccessfully: t("collections.mutations.itemUpdatedSuccessfully"),
    itemDeletedSuccessfully: t("collections.mutations.itemDeletedSuccessfully"),
    createItemFailed: t("collections.mutations.createItemFailed"),
    updateItemFailed: t("collections.mutations.updateItemFailed"),
    deleteItemFailed: t("collections.mutations.deleteItemFailed"),
  });

  return <>{children}</>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <Toaster />
      <Suspense fallback={<SplashScreen />}>
        <ThemeProvider>
          <AuthConfigProvider>
            <BetterAuthUIProvider>
              <PostHogIdentitySync>
                <SdkTranslationInitializer>
                  {children}
                </SdkTranslationInitializer>
              </PostHogIdentitySync>
            </BetterAuthUIProvider>
          </AuthConfigProvider>
        </ThemeProvider>
      </Suspense>
    </QueryClientProvider>
  );
}
