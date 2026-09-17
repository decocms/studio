/**
 * Make a payment visible in the browser that started it.
 *
 * Stripe is opened in a NEW TAB (`use-open-billing-url.ts`), so the tab the
 * user was working in keeps its react-query cache untouched, and the tab Stripe
 * redirects lands on `?checkout=success` with nothing reading it. Entitlements
 * have a 60s `staleTime` and no refetch interval, so both tabs could sit on the
 * old plan — paywalls up, bar unmoved — long after the card cleared.
 *
 * Invalidating ONCE is not enough either, and that is the real shape of this
 * problem: the tier is granted by the Stripe WEBHOOK, which lands whenever it
 * lands. The redirect routinely beats it. A single refetch on arrival therefore
 * re-reads the OLD plan and caches it for another minute, which looks exactly
 * like the bug it was meant to fix. So this keeps asking for a bounded window.
 *
 * Shaped as a query rather than a timer because `useEffect` is banned here and
 * because react-query already owns exactly this: an interval, its cleanup, and
 * a pause when the tab is hidden. The `queryFn` invalidating a sibling query is
 * the one unusual part — this query's own data is just a tick counter.
 *
 * ponytail: it polls for the whole window rather than stopping the moment the
 * plan changes, and it re-arms on reload because `?checkout` is left on the
 * URL. Both are deliberate: comparing before/after needs remembered state, and
 * stopping early saves ~15 requests on a query the page is already making. If
 * this ever needs to be exact, have the webhook publish to the org's existing
 * SSE stream (`sseHub.emit`) and delete this file — that is the push path
 * CLAUDE.md asks for, and it is the right end state.
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { KEYS } from "@/lib/query-keys";

/** How long to keep asking, and how often. The webhook is usually in before the
 *  first tick; the tail is for a gateway retry or a queued delivery. */
const POLL_INTERVAL_MS = 2_000;
const POLL_WINDOW_MS = 40_000;

/** The values our own Stripe return URLs use: `?checkout=success` from a first
 *  subscribe or a top-up, `?checkout=updated` from a portal tier change. */
function isCheckoutReturn(value: unknown): boolean {
  return value === "success" || value === "updated";
}

export function useCheckoutReturn(orgId: string): void {
  const search = useSearch({ strict: false }) as { checkout?: unknown };
  const queryClient = useQueryClient();
  const isReturn = isCheckoutReturn(search.checkout);

  // Lazy initializer: computed during the first render, which is the mount time
  // we want to measure from. Not an effect, and stable across re-renders.
  const [deadline] = useState(() => Date.now() + POLL_WINDOW_MS);

  useQuery({
    queryKey: KEYS.checkoutReturnPoll(orgId),
    enabled: isReturn,
    // Never served from cache — each run is a fresh nudge, not a value.
    gcTime: 0,
    staleTime: 0,
    refetchInterval: () =>
      Date.now() < deadline ? POLL_INTERVAL_MS : (false as const),
    queryFn: async () => {
      await queryClient.invalidateQueries({
        queryKey: KEYS.aiPlanEntitlements(orgId),
      });
      return Date.now();
    },
  });
}
