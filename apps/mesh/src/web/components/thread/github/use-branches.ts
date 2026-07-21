import { KEYS, type SandboxMap, useMCPClient } from "@decocms/mesh-sdk";
import { useInfiniteQuery } from "@tanstack/react-query";

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
  defaultBase: string | null;
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  fetchMore: () => void;
  fetchUntilMatch: (
    search: string,
    shouldContinue?: () => boolean,
  ) => Promise<void>;
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

const BRANCHES_PER_PAGE = 100;
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function pageHasBranchMatch(
  pages: BranchesPage[] | undefined,
  search: string,
  excludedNames: Set<string>,
): boolean {
  const normalizedSearch = search.trim().toLowerCase();
  if (!normalizedSearch) return true;

  return (pages ?? []).some((page) =>
    page.branches.some(
      (branch) =>
        typeof branch.name === "string" &&
        !excludedNames.has(branch.name) &&
        branch.name.toLowerCase().includes(normalizedSearch),
    ),
  );
}

function branchNamesHaveMatch(
  branchNames: Set<string>,
  search: string,
): boolean {
  const normalizedSearch = search.trim().toLowerCase();
  if (!normalizedSearch) return true;

  return [...branchNames].some((branchName) =>
    branchName.toLowerCase().includes(normalizedSearch),
  );
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

/**
 * Lists branches for the picker.
 *
 * - "yours" are derived from sandboxMap[userId] — no network call.
 * - "others" are from the github-mcp-server's list_branches tool, minus
 *   the yours set. If the fetch fails the picker still shows yours.
 * - defaultBase is the repo's default branch when exposed by the response;
 *   callers fall back to "main" otherwise.
 */
export function useBranches({
  orgId,
  orgSlug,
  userId,
  connectionId,
  sandboxMap,
  owner,
  repo,
  enabled = true,
}: UseBranchesArgs): UseBranchesResult {
  const client = useMCPClient({
    connectionId: connectionId ?? null,
    orgId,
    orgSlug,
  });

  const {
    data,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery<BranchesPage>({
    queryKey: KEYS.githubBranches(orgId, orgSlug, connectionId, owner, repo),
    enabled: enabled && !!connectionId && !!owner && !!repo,
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

  // Aggregate sandbox activity across ALL users: who is on each branch and
  // when it was last started. Powers the "Last 7 days" group + contributor
  // avatars. sandboxMap shape: sandboxMap[userId][branch][kind] -> record.
  const activityByBranch = new Map<
    string,
    { userIds: Set<string>; lastActiveAt: number }
  >();
  for (const [uid, branches] of Object.entries(sandboxMap ?? {})) {
    for (const [branch, kinds] of Object.entries(branches ?? {})) {
      let entry = activityByBranch.get(branch);
      if (!entry) {
        entry = { userIds: new Set(), lastActiveAt: 0 };
        activityByBranch.set(branch, entry);
      }
      entry.userIds.add(uid);
      for (const record of Object.values(kinds ?? {})) {
        const createdAt = record?.createdAt ?? 0;
        if (createdAt > entry.lastActiveAt) entry.lastActiveAt = createdAt;
      }
    }
  }

  const recentCutoff = Date.now() - RECENT_WINDOW_MS;
  const recent: Branch[] = [...activityByBranch.entries()]
    .filter(([, activity]) => activity.lastActiveAt >= recentCutoff)
    .sort((a, b) => b[1].lastActiveAt - a[1].lastActiveAt)
    .map(([name, activity]) => ({
      name,
      source: "recent" as const,
      contributors: [...activity.userIds],
      lastActiveAt: activity.lastActiveAt,
    }));
  const recentNames = new Set(recent.map((b) => b.name));

  const yourBranchNames = new Set(Object.keys(sandboxMap?.[userId] ?? {}));
  const yours: Branch[] = [...yourBranchNames]
    .filter((name) => !recentNames.has(name))
    .sort()
    .map((name) => ({ name, source: "yours" as const }));

  const branchesByName = new Map<string, RawBranch>();
  for (const page of data?.pages ?? []) {
    for (const branch of page.branches) {
      if (typeof branch.name === "string") {
        branchesByName.set(branch.name, branch);
      }
    }
  }

  const rawBranches: RawBranch[] = [...branchesByName.values()];

  const others: Branch[] = rawBranches
    .filter(
      (b): b is RawBranch & { name: string } => typeof b.name === "string",
    )
    .filter((b) => !yourBranchNames.has(b.name) && !recentNames.has(b.name))
    .map((b) => ({
      name: b.name,
      source: "other" as const,
      author:
        typeof b.commit?.author === "string"
          ? b.commit.author
          : (b.commit?.author?.login ?? null),
    }));

  const defaultBase =
    data?.pages.find((page) => page.default_branch)?.default_branch ?? null;
  const fetchUntilMatch = async (
    search: string,
    shouldContinue = () => true,
  ) => {
    if (
      !shouldContinue() ||
      branchNamesHaveMatch(yourBranchNames, search) ||
      isFetchingNextPage
    ) {
      return;
    }

    let pages = data?.pages ?? [];
    while (
      shouldContinue() &&
      !pageHasBranchMatch(pages, search, yourBranchNames) &&
      (pages.at(-1)?.branches.length ?? BRANCHES_PER_PAGE) >= BRANCHES_PER_PAGE
    ) {
      const result = await fetchNextPage();
      if (!shouldContinue()) {
        break;
      }
      const nextPages = result.data?.pages ?? pages;
      if (nextPages.length === pages.length) {
        break;
      }
      pages = nextPages;
    }
  };

  return {
    recent,
    yours,
    others,
    defaultBase,
    isLoading,
    isError,
    hasMore: hasNextPage ?? false,
    isFetchingMore: isFetchingNextPage,
    fetchMore: () => {
      if (hasNextPage && !isFetchingNextPage) {
        void fetchNextPage();
      }
    },
    fetchUntilMatch,
  };
}
