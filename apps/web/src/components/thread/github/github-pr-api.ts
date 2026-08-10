import {
  extractToolJson,
  pullNumberFromUrl,
  pullRequestFromToolText,
  toolErrorMessage,
} from "./extract-tool-json.ts";
import {
  appendCoAuthorToPullRequestBody,
  appendCoAuthorTrailer,
  normalizeCoAuthorIdentity,
  type CoAuthorIdentity,
} from "@decocms/sandbox/shared";

type GithubMcpClient = {
  callTool: (req: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>;
};

export interface CreatedPullRequest {
  number: number;
  htmlUrl: string;
}

export interface MergedPullRequest {
  merged: boolean;
  message: string;
}

export interface OpenPullRequestArgs {
  owner: string;
  repo: string;
  branch: string;
  title: string;
  body?: string;
  base: string;
  coAuthor?: CoAuthorIdentity;
  /**
   * The branch's already-known open PR, supplied by the caller from its polled
   * PR state. When present we reuse it directly instead of calling
   * `list_pull_requests` — keeping that rate-limit-heavy call out of the
   * publish/submit path.
   */
  existing?: CreatedPullRequest;
}

/**
 * Thrown when `create_pull_request` reports a PR already exists for the branch
 * but the caller had no `existing` PR to reuse (its polled state was stale).
 * Retrying once the PR panel refreshes resolves it — see
 * {@link openPullRequestForBranch}.
 */
export const PULL_REQUEST_ALREADY_EXISTS_MESSAGE =
  "A pull request already exists for this branch. Refresh and try again.";

function assertGithubToolSuccess(result: unknown): void {
  const message = toolErrorMessage(result);
  if (message) throw new Error(message);
}

function pickString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pickNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      const n = Number(value);
      if (n > 0) return n;
    }
  }
  return undefined;
}

export function extractPullRequestList(
  result: unknown,
): Record<string, unknown>[] {
  const raw = extractToolJson<unknown>(result);
  if (Array.isArray(raw)) {
    return raw.filter(
      (item): item is Record<string, unknown> =>
        item != null && typeof item === "object",
    );
  }
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of ["pull_requests", "items", "data"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        return value.filter(
          (item): item is Record<string, unknown> =>
            item != null && typeof item === "object",
        );
      }
    }
  }
  return [];
}

/** github-mcp-server create_pull_request returns MinimalResponse `{ id, url }`. */
export function parseCreatedPullRequestResult(
  result: unknown,
): CreatedPullRequest {
  assertGithubToolSuccess(result);

  const fromText = pullRequestFromToolText(result);
  if (fromText) return fromText;

  const data = extractToolJson<Record<string, unknown>>(result);
  if (data && typeof data === "object") {
    const htmlUrl = pickString(data, ["url", "URL", "html_url", "htmlUrl"]);
    const number =
      pickNumber(data, ["number", "pullNumber"]) ?? pullNumberFromUrl(htmlUrl);
    if (number && htmlUrl) return { number, htmlUrl };
  }

  throw new Error("Failed to open pull request");
}

function pullRequestAlreadyExists(message: string): boolean {
  return /already exists|pull request already/i.test(message);
}

async function ensureExistingPullRequestCoAuthor(
  client: GithubMcpClient,
  args: {
    owner: string;
    repo: string;
    pullNumber: number;
    body?: string;
    coAuthor?: CoAuthorIdentity;
  },
): Promise<void> {
  const body = appendCoAuthorToPullRequestBody(
    args.body,
    normalizeCoAuthorIdentity(args.coAuthor),
  );
  if (!body) return;

  try {
    await client.callTool({
      name: "update_pull_request",
      arguments: {
        owner: args.owner,
        repo: args.repo,
        pullNumber: args.pullNumber,
        body,
      },
    });
  } catch {
    // Best-effort when the GitHub MCP tool is unavailable or rejects the update.
  }
}

async function createPullRequest(
  client: GithubMcpClient,
  args: {
    owner: string;
    repo: string;
    title: string;
    body?: string;
    head: string;
    base: string;
    coAuthor?: CoAuthorIdentity;
  },
): Promise<CreatedPullRequest> {
  const body = appendCoAuthorToPullRequestBody(
    args.body,
    normalizeCoAuthorIdentity(args.coAuthor),
  );
  const result = await client.callTool({
    name: "create_pull_request",
    arguments: {
      owner: args.owner,
      repo: args.repo,
      title: args.title,
      body: body || undefined,
      head: args.head,
      base: args.base,
    },
  });

  return parseCreatedPullRequestResult(result);
}

/**
 * Reuses the branch's open PR when the caller already knows it (`args.existing`,
 * from its polled PR state), otherwise creates one. This path deliberately does
 * NOT call `list_pull_requests`: on GitHub's hosted MCP that list is a top
 * rate-limit contributor, and the publish/submit flows run inside it. If no
 * `existing` PR is supplied and `create_pull_request` reports a duplicate, we
 * surface {@link PULL_REQUEST_ALREADY_EXISTS_MESSAGE} rather than listing to
 * recover it — the PR panel repopulates `existing` on its next poll, so a retry
 * succeeds without us adding another list call here.
 */
export async function openPullRequestForBranch(
  client: GithubMcpClient,
  args: OpenPullRequestArgs,
): Promise<CreatedPullRequest> {
  if (args.existing) {
    await ensureExistingPullRequestCoAuthor(client, {
      owner: args.owner,
      repo: args.repo,
      pullNumber: args.existing.number,
      body: args.body,
      coAuthor: args.coAuthor,
    });
    return args.existing;
  }

  try {
    return await createPullRequest(client, {
      owner: args.owner,
      repo: args.repo,
      title: args.title,
      body: args.body,
      head: args.branch,
      base: args.base,
      coAuthor: args.coAuthor,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (pullRequestAlreadyExists(message)) {
      throw new Error(PULL_REQUEST_ALREADY_EXISTS_MESSAGE);
    }
    throw err;
  }
}

export async function squashMergePullRequest(
  client: GithubMcpClient,
  args: {
    owner: string;
    repo: string;
    pullNumber: number;
    commitTitle?: string;
    commitMessage?: string;
    coAuthor?: CoAuthorIdentity;
  },
): Promise<MergedPullRequest> {
  const normalized = normalizeCoAuthorIdentity(args.coAuthor);
  const commitMessage = normalized
    ? appendCoAuthorTrailer(args.commitMessage?.trim() ?? "", normalized)
    : args.commitMessage?.trim() || undefined;
  const result = await client.callTool({
    name: "merge_pull_request",
    arguments: {
      owner: args.owner,
      repo: args.repo,
      pullNumber: args.pullNumber,
      merge_method: "squash",
      ...(args.commitTitle ? { commit_title: args.commitTitle } : {}),
      ...(commitMessage ? { commit_message: commitMessage } : {}),
    },
  });

  assertGithubToolSuccess(result);

  const data = extractToolJson<{ merged?: boolean; message?: string }>(result);
  if (!data || data.merged !== true) {
    throw new Error(data?.message ?? "Failed to merge pull request");
  }

  return {
    merged: true,
    message: data.message ?? "Pull request merged",
  };
}
