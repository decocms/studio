import { type VmMap, useMCPClient } from "@decocms/mesh-sdk";
import { useInfiniteQuery } from "@tanstack/react-query";

export interface Branch {
  name: string;
  source: "yours" | "other";
  author?: string | null;
}

export interface UseBranchesResult {
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
  vmMap: VmMap | undefined;
  owner: string;
  repo: string;
  /**
   * When false the github fetch is skipped (e.g. dialog closed).
   * Your-branches still resolve from the in-memory vmMap.
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
 * - "yours" are derived from vmMap[userId] — no network call.
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
  vmMap,
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
    queryKey: ["github-branches", orgId, orgSlug, connectionId, owner, repo],
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

  const yourBranchNames = new Set(Object.keys(vmMap?.[userId] ?? {}));
  const yours: Branch[] = [...yourBranchNames]
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
    .filter((b) => !yourBranchNames.has(b.name))
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
