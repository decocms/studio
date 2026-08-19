import { KEYS, type SandboxMap, useMCPClient } from "@/sdk";
import { callStudioTool } from "@/lib/studio-tools";
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
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
   * Matches the server found but did not return (search is capped at
   * `SEARCH_LIMIT`). 0 when browsing or when every match is shown.
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
  connectionId: string | null | undefined;
  sandboxMap: SandboxMap | undefined;
  owner: string;
  repo: string;
  /**
   * Current search term. Non-empty switches the repo list from paged browsing
   * to a server-side search; sandbox-derived groups always filter locally.
   */
  search?: string;
  /**
   * When false the github fetch is skipped (e.g. dialog closed).
   * Your-branches still resolve from the in-memory sandboxMap.
   */
  enabled?: boolean;
}

type RawBranch = {
  name?: string;
  commit?: { author?: { login?: string } | string | null } | null;
};

type RawBranchesResponse =
  | RawBranch[]
  | {
      branches?: RawBranch[];
      default_branch?: string;
    };

interface BranchesPage {
  branches: RawBranch[];
  default_branch: string | null;
  page: number;
}

/** Flattens paged `list_branches` results, last page winning on duplicates. */
export function dedupePagedBranches(
  pages: { branches: RawBranch[] }[] | undefined,
): { name: string; author: string | null }[] {
  const byName = new Map<string, RawBranch>();
  for (const page of pages ?? []) {
    for (const branch of page.branches) {
      if (typeof branch.name === "string") byName.set(branch.name, branch);
    }
  }
  return [...byName.values()].map((b) => ({
    name: b.name as string,
    author:
      typeof b.commit?.author === "string"
        ? b.commit.author
        : (b.commit?.author?.login ?? null),
  }));
}

const BRANCHES_PER_PAGE = 100;
/** Enough to fill the picker without paging; the server reports the true total. */
const SEARCH_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 300;

/** Case-insensitive substring — the same predicate GitHub's `refs(query:)` applies. */
export function matchesBranchSearch(name: string, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return name.toLowerCase().includes(needle);
}

/**
 * github-mcp-server may return either:
 * - `structuredContent` with parsed JSON, OR
 * - `content: [{ type: "text", text: "<json>" }]` (most common)
 * Accept both.
 */
function extractBranches(r: unknown): RawBranchesResponse {
  const result = r as {
    structuredContent?: RawBranchesResponse;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (result.structuredContent) return result.structuredContent;
  const textPart = result.content?.find((c) => c.type === "text")?.text;
  if (textPart) {
    try {
      return JSON.parse(textPart) as RawBranchesResponse;
    } catch {
      return [];
    }
  }
  return [];
}

/** Branches for the picker: sandboxMap for yours/recent, github for the rest. */
export function useBranches({
  orgId,
  orgSlug,
  userId,
  connectionId,
  sandboxMap,
  owner,
  repo,
  search = "",
  enabled = true,
}: UseBranchesArgs): UseBranchesResult {
  const client = useMCPClient({
    connectionId: connectionId ?? null,
    orgId,
    orgSlug,
  });

  const trimmedSearch = search.trim();
  const debouncedSearch = useDebouncedValue(trimmedSearch, SEARCH_DEBOUNCE_MS);
  const repoReady = !!connectionId && !!owner && !!repo;
  const isSearchMode = trimmedSearch.length > 0;

  const {
    data,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery<BranchesPage>({
    queryKey: KEYS.githubBranches(orgId, orgSlug, connectionId, owner, repo),
    enabled: enabled && repoReady && !isSearchMode,
    staleTime: 30_000,
    retry: false,
    initialPageParam: 1,
    queryFn: async ({ pageParam, signal }) => {
      const page = Number(pageParam);
      const result = await client.callTool(
        {
          name: "list_branches",
          arguments: { owner, repo, page, perPage: BRANCHES_PER_PAGE },
        },
        undefined,
        { signal },
      );
      const parsed = extractBranches(result);
      const branches = Array.isArray(parsed) ? parsed : (parsed.branches ?? []);

      return {
        branches,
        default_branch: Array.isArray(parsed)
          ? null
          : (parsed.default_branch ?? null),
        page,
      };
    },
    getNextPageParam: (lastPage) => {
      if (lastPage.branches.length < BRANCHES_PER_PAGE) {
        return undefined;
      }

      return lastPage.page + 1;
    },
  });

  const {
    data: searchData,
    isLoading: isSearchLoading,
    isError: isSearchError,
    isFetching: isSearchFetching,
  } = useQuery({
    queryKey: KEYS.githubBranchSearch(
      orgId,
      orgSlug,
      connectionId,
      owner,
      repo,
      debouncedSearch,
    ),
    enabled: enabled && repoReady && debouncedSearch.length > 0,
    staleTime: 30_000,
    retry: false,
    queryFn: () =>
      callStudioTool(orgSlug, "GITHUB_SEARCH_BRANCHES", {
        connectionId: connectionId as string,
        owner,
        repo,
        query: debouncedSearch,
        limit: SEARCH_LIMIT,
      }),
  });

  // Results still describe the pre-debounce term, so count the gap as pending.
  const isSearching =
    isSearchMode && (debouncedSearch !== trimmedSearch || isSearchFetching);

  // Until the first search settles, the already-paged branches are the only
  // matches we can show; cmdk narrows them with the same predicate the server
  // applies, so the list filters instantly instead of blanking for a debounce.
  const rawBranches = searchData
    ? searchData.branches
    : dedupePagedBranches(data?.pages);

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

  const hiddenMatchCount =
    searchData && !isSearching
      ? Math.max(0, searchData.totalCount - searchData.branches.length)
      : 0;

  return {
    recent,
    yours,
    others,
    isLoading: isSearchMode ? isSearchLoading : isLoading,
    isError: isSearchMode ? isSearchError : isError,
    isSearching,
    hiddenMatchCount,
    // Paging browses the full repo list; a search is answered in one shot.
    hasMore: !isSearchMode && (hasNextPage ?? false),
    isFetchingMore: isFetchingNextPage,
    fetchMore: () => {
      if (!isSearchMode && hasNextPage && !isFetchingNextPage) {
        void fetchNextPage();
      }
    },
  };
}
