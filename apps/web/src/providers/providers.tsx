import { Suspense } from "react";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { setCollectionToastTranslations } from "@/sdk";
import { PLAN_REFUSAL_CODES, planRefusalOf } from "@/lib/studio-tools";

import { AuthConfigProvider } from "@/providers/auth-config-provider";
import { BetterAuthUIProvider } from "@/providers/better-auth-ui-provider";
import { PostHogIdentitySync } from "@/providers/posthog-provider";
import { BootGate } from "@/layouts/boot-gate";
import { SplashScreen } from "@/components/splash-screen";
import { ThemeProvider } from "@/providers/theme-provider";
import { hydrateQueryClient, persistQueryClient } from "@/lib/query-persist";
import {
  persistHtmlResourceCache,
  restoreHtmlResourceCache,
} from "@/lib/html-resource-persist";
import { Toaster, toast } from "sonner";
import { useT } from "@/i18n/use-t";

/**
 * Say what a plan refusal is, wherever it lands.
 *
 * The server returns two precise codes on a 403 — `feature_not_in_plan` and
 * `ai_budget_exhausted` — and nothing in the client read either one, so every
 * window in which the client's gate fails open (first paint, an org switch, an
 * error state, a cross-pod skew right after an upgrade) ended in a generic
 * error the user could not tell from a bug. Handled centrally because the
 * refusal can arrive from any surface, and `sonner` is already global.
 *
 * Deliberately a toast and not a dialog: this fires from arbitrary queries,
 * including background refetches, and a modal on a background refetch would be
 * worse than the generic error it replaces. The paywall dialog stays where the
 * user actively reached for the feature.
 */
function notifyPlanRefusal(error: unknown): void {
  const refusal = planRefusalOf(error);
  if (!refusal) return;
  const message =
    refusal === PLAN_REFUSAL_CODES.aiBudgetExhausted
      ? planRefusalCopy.budget
      : planRefusalCopy.feature;
  // Deduped by id: one refusal per kind on screen, not one per failed query in
  // a prefetch batch.
  toast.error(message, { id: `plan-refusal:${refusal}` });
}

/** Filled in by SdkTranslationInitializer — the caches outlive any component. */
const planRefusalCopy = { feature: "", budget: "" };

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: notifyPlanRefusal }),
  mutationCache: new MutationCache({ onError: notifyPlanRefusal }),
  defaultOptions: {
    queries: {
      // Data is fresh for 1 minute by default
      staleTime: 60_000,
      // Only refetch on window focus if data is stale (respects staleTime)
      refetchOnWindowFocus: true,
      // Don't refetch on mount if data is still fresh
      refetchOnMount: true,
      // Retry failed requests (but not too aggressively) — but never retry a
      // plan refusal: it is a decision about this org, not a blip, so a retry
      // only doubles the load and delays the message.
      retry: (failureCount, error) =>
        planRefusalOf(error) === null && failureCount < 1,
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

  planRefusalCopy.feature = t("settings.paywall.serverRefusedFeature");
  planRefusalCopy.budget = t("settings.paywall.serverRefusedBudget");

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
      {/* The app's ONE splash boundary. It stays suspended from first paint
          until `BootGate` has the shell's prerequisites in hand, so the splash
          is a single mounted element that plays its animation once — see
          `layouts/boot-gate.tsx`. Nothing below here may render a splash of its
          own: a second boundary is a second element, and a second element
          restarts the animation. */}
      <Suspense fallback={<SplashScreen />}>
        <ThemeProvider>
          <AuthConfigProvider>
            <BetterAuthUIProvider>
              <PostHogIdentitySync>
                <SdkTranslationInitializer>
                  <BootGate>{children}</BootGate>
                </SdkTranslationInitializer>
              </PostHogIdentitySync>
            </BetterAuthUIProvider>
          </AuthConfigProvider>
        </ThemeProvider>
      </Suspense>
    </QueryClientProvider>
  );
}
