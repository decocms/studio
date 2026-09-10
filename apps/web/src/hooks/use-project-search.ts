/** Cross-organization project search.
 *
 *  The one place the picker looks once someone types. It does NOT ride on the
 *  per-org project list: that endpoint reads an org's whole project graph with
 *  no limit and filters in JavaScript, so searching every org that way would be
 *  one full scan per org, per keystroke. This is a single bounded query joined
 *  against the caller's memberships.
 *
 *  Because the answer spans organizations it is keyed on the term alone — the
 *  org you happen to be looking at does not change it. */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { KEYS } from "@/lib/query-keys";

export interface ProjectSearchHit {
  id: string;
  title: string;
  icon: string | null;
  orgId: string;
  orgName: string;
  orgSlug: string;
}

interface ProjectSearchResponse {
  items: ProjectSearchHit[];
}

export interface ProjectSearchResult {
  hits: ProjectSearchHit[];
  /** A request for the CURRENT term is in flight. */
  isSearching: boolean;
  /** `hits` still belong to the previous term. Held on purpose so the list does
   *  not blink empty between keystrokes; dim them rather than hide them. */
  isStale: boolean;
  isError: boolean;
}

/**
 * Projects matching `term` across every org the user belongs to.
 *
 * Pass the DEBOUNCED term: one request per distinct value reaches the server.
 * An empty term is not a query — the picker browses instead of searching.
 */
export function useProjectSearch(term: string): ProjectSearchResult {
  const trimmed = term.trim();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? "";
  /** No principal, no request: the answer is per-user, and firing before the
   *  session resolves would cache one under the empty key that a later user
   *  would read back. */
  const enabled = trimmed.length > 0 && !!userId;

  const { data, isFetching, isPlaceholderData, isError } = useQuery({
    queryKey: KEYS.projectSearch(userId, trimmed),
    /** `signal` comes from the query and aborts when this observer is
     *  superseded or unmounted — so typing past a term cancels its request in
     *  flight instead of leaving it to land unread. */
    queryFn: async ({ signal }): Promise<ProjectSearchResponse> => {
      const res = await fetch(
        `/api/_me/projects/search?q=${encodeURIComponent(trimmed)}`,
        { signal },
      );
      if (!res.ok) throw new Error(`Project search failed: ${res.status}`);
      return (await res.json()) as ProjectSearchResponse;
    },
    enabled,
    /** Keep the previous term's rows on screen while the next term loads.
     *  Without this every keystroke empties the list and then refills it, which
     *  reads as flicker and moves the highlighted row out from under the
     *  keyboard. */
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });

  return {
    hits: data?.items ?? [],
    isSearching: enabled && isFetching,
    isStale: enabled && isPlaceholderData,
    isError,
  };
}
