import {
  type VmMap,
  useMCPClient,
  useMCPToolCallQuery,
} from "@decocms/mesh-sdk";

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

  const { data, isLoading, isError } = useMCPToolCallQuery<RawBranchesResponse>(
    {
      client,
      toolName: "list_branches",
      toolArguments: { owner, repo },
      enabled: enabled && !!connectionId && !!owner && !!repo,
      staleTime: 30_000,
      select: (r) => extractBranches(r),
    },
  );

  const yourBranchNames = new Set(Object.keys(vmMap?.[userId] ?? {}));
  const yours: Branch[] = [...yourBranchNames]
    .sort()
    .map((name) => ({ name, source: "yours" as const }));

  const rawBranches: RawBranch[] = Array.isArray(data)
    ? data
    : (data?.branches ?? []);

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

  const defaultBase = Array.isArray(data)
    ? null
    : (data?.default_branch ?? null);

  return {
    yours,
    others,
    defaultBase,
    isLoading,
    isError,
  };
}
