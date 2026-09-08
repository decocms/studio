/**
 * Branches for the picker: the sandbox map for yours/recent, the repository's
 * provider for the rest.
 *
 * Browsing and searching are ONE server call with different arguments —
 * `REPOSITORY_SEARCH_BRANCHES` with an empty query browses from the start, and
 * with a term filters at the provider. They used to be two paths: a paged MCP
 * `list_branches` against the GitHub connection, plus a GitHub-only search
 * tool. Collapsing them is what lets a GitLab project's picker work at all,
 * and it deletes the local dedupe the paged path needed.
 */

import { type SandboxMap } from "@/sdk";
import {
  hasRepoCredential,
  type RepoToolTarget,
  repoTargetKey,
} from "@/lib/github-repo";
import { KEYS } from "@/lib/query-keys";
import { callStudioTool } from "@/lib/studio-tools";
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { groupBranches } from "./group-branches";

export interface Branch {
  name: string;
  source: "yours" | "other" | "recent";
  author?: string | null;
  /** userIds with an active sandbox on this branch (from sandboxMap). */
  contributors?: string[];
  /** Most recent sandbox createdAt (epoch ms) across all users on the branch. */
  lastActiveAt?: number;
}

export interface UseBranchesResult {
  /**
   * Branches with sandbox activity in the last 7 days (any user), most recent
   * first. Carries `contributors` so the picker can show who's working on it.
   */
  recent: Branch[];
  yours: Branch[];
  others: Branch[];
  isLoading: boolean;
  isError: boolean;
  /** True while a server-side search for the current term is in flight. */
  isSearching: boolean;
  /**
   * Matches the server found but did not return (a search reads one window).
   * 0 when browsing or when every match is shown.
   */
  hiddenMatchCount: number;
  hasMore: boolean;
  isFetchingMore: boolean;
  fetchMore: () => void;
}

interface UseBranchesArgs {
  orgId: string;
  orgSlug: string;
  userId: string;
  target: RepoToolTarget;
  sandboxMap: SandboxMap | undefined;
  owner: string;
  repo: string;
  /**
   * Current search term. Non-empty switches the repository list from paged
   * browsing to a provider-side search; sandbox-derived groups always filter
   * locally.
   */
  search?: string;
  /**
   * When false the provider fetch is skipped (e.g. dialog closed).
   * Your-branches still resolve from the in-memory sandboxMap.
   */
  enabled?: boolean;
}

/** One window big enough to fill the picker; the server reports the true total. */
const BRANCHES_PER_PAGE = 100;
const SEARCH_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 300;

/** Case-insensitive substring — the same predicate the providers apply. */
export function matchesBranchSearch(name: string, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return name.toLowerCase().includes(needle);
}

export function useBranches({
  orgId,
  orgSlug,
  userId,
  target,
  sandboxMap,
  owner,
  repo,
  search = "",
  enabled = true,
}: UseBranchesArgs): UseBranchesResult {
  const trimmedSearch = search.trim();
  const debouncedSearch = useDebouncedValue(trimmedSearch, SEARCH_DEBOUNCE_MS);
  /**
   * A repository row is enough on its own — a GitLab project never has a
   * connection, so requiring one here is what would keep its picker empty.
   */
  const repoReady = hasRepoCredential(target);
  const isSearchMode = trimmedSearch.length > 0;

  /**
   * One query for both modes, keyed by the debounced term: browsing is the
   * empty-term case, so switching to a search does not throw away the browse
   * pages and switching back does not refetch them.
   */
  const {
    data,
    isLoading,
    isError,
    isFetching,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: KEYS.githubBranchSearch(
      orgId,
      orgSlug,
      repoTargetKey(target),
      owner,
      repo,
      debouncedSearch,
    ),
    enabled: enabled && repoReady,
    staleTime: 30_000,
    retry: false,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      callStudioTool(orgSlug, "REPOSITORY_SEARCH_BRANCHES", {
        ...target,
        query: debouncedSearch,
        limit: debouncedSearch ? SEARCH_LIMIT : BRANCHES_PER_PAGE,
        cursor: pageParam,
      }),
    // A search reads one window and reports the rest as a count; only browsing pages.
    getNextPageParam: (lastPage) =>
      debouncedSearch ? undefined : (lastPage.nextCursor ?? undefined),
  });

  // Results still describe the pre-debounce term, so count the gap as pending.
  const isSearching =
    isSearchMode && (debouncedSearch !== trimmedSearch || isFetching);

  const rawBranches = (data?.pages ?? []).flatMap((page) => page.branches);

  const grouped = groupBranches({
    sandboxMap,
    userId,
    rawBranches,
    now: Date.now(),
  });

  // Keeps the derived counts honest about what cmdk actually renders.
  const recent = grouped.recent.filter((b) =>
    matchesBranchSearch(b.name, trimmedSearch),
  );
  const yours = grouped.yours.filter((b) =>
    matchesBranchSearch(b.name, trimmedSearch),
  );
  const others = grouped.others;

  const firstPage = data?.pages[0];
  const hiddenMatchCount =
    isSearchMode && firstPage && !isSearching
      ? Math.max(0, firstPage.totalCount - firstPage.branches.length)
      : 0;

  return {
    recent,
    yours,
    others,
    isLoading,
    isError,
    isSearching,
    hiddenMatchCount,
    hasMore: !isSearchMode && hasNextPage,
    isFetchingMore: isFetchingNextPage,
    fetchMore: () => {
      void fetchNextPage();
    },
  };
}
