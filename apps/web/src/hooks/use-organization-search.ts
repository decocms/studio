/** Server-side search over the user's organizations.
 *
 *  The in-memory org list comes from Better Auth, whose adapter stops at 500
 *  rows, so filtering it locally cannot find an org past that page. */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { KEYS } from "@/lib/query-keys";

export interface OrganizationSearchHit {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
}

interface OrganizationSearchResponse {
  items: OrganizationSearchHit[];
}

function isOrganizationSearchResponse(
  value: unknown,
): value is OrganizationSearchResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Record<string, unknown>).items)
  );
}

export interface OrganizationSearchResult {
  hits: OrganizationSearchHit[];
  /** A request for the CURRENT term is in flight. */
  isSearching: boolean;
  /** `hits` still belong to the previous term, kept so the list does not
   *  blink empty between keystrokes. */
  isStale: boolean;
  isError: boolean;
}

/**
 * Organizations matching `term` among every org the user belongs to.
 *
 * Pass the DEBOUNCED term. An empty term is not a query.
 */
export function useOrganizationSearch(term: string): OrganizationSearchResult {
  const trimmed = term.trim();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? "";
  const enabled = trimmed.length > 0 && !!userId;

  const { data, isFetching, isPlaceholderData, isError } = useQuery({
    queryKey: KEYS.organizationSearch(userId, trimmed),
    queryFn: async ({ signal }): Promise<OrganizationSearchResponse> => {
      const res = await fetch(
        `/api/_me/organizations/search?q=${encodeURIComponent(trimmed)}`,
        { signal },
      );
      if (!res.ok) throw new Error(`Organization search failed: ${res.status}`);
      const data = await res.json();
      if (!isOrganizationSearchResponse(data)) {
        throw new Error("Invalid organization search response");
      }
      return data;
    },
    enabled,
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
