/** The app's one query client, in its own module so router loaders can read
 *  the same cache the components do. */

import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PLAN_REFUSAL_CODES, planRefusalOf } from "@/lib/studio-tools";
import { hydrateQueryClient, persistQueryClient } from "@/lib/query-persist";
import {
  persistHtmlResourceCache,
  restoreHtmlResourceCache,
} from "@/lib/html-resource-persist";

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
  // Fallbacks for a refusal that lands before SdkTranslationInitializer fills the copy.
  const message =
    refusal === PLAN_REFUSAL_CODES.aiBudgetExhausted
      ? planRefusalCopy.budget || "This organization's AI allowance is used up."
      : planRefusalCopy.feature ||
        "This organization's plan does not include that.";
  // One toast per refusal kind, not one per failed query in a batch.
  toast.error(message, { id: `plan-refusal:${refusal}` });
}

/** Filled in by SdkTranslationInitializer — the caches outlive any component. */
export const planRefusalCopy = { feature: "", budget: "" };

export const queryClient = new QueryClient({
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
      // Retry once, but never a plan refusal: it is a decision, not a blip.
      retry: (failureCount, error) =>
        planRefusalOf(error) === null && failureCount < 1,
      // Keep unused data in cache for 5 minutes
      gcTime: 5 * 60 * 1000,
    },
  },
});

hydrateQueryClient(queryClient);
persistQueryClient(queryClient);
// Large UI-resource HTML warm-starts from IndexedDB, not the localStorage cache.
void restoreHtmlResourceCache(queryClient);
persistHtmlResourceCache(queryClient);
