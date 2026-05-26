import {
  extractToolJson,
  pullNumberFromUrl,
  pullRequestFromToolText,
} from "./extract-tool-json.ts";

type GithubMcpClient = {
  callTool: (req: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>;
};

type ToolResultLike = {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
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
}

function toolErrorMessage(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as ToolResultLike;
  if (!r.isError) return null;
  const text = r.content?.find((c) => c.type === "text")?.text?.trim();
  return text || "GitHub MCP tool returned an error";
}

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

function headRefFromListItem(pr: Record<string, unknown>): string | null {
  const head = pr.head as Record<string, unknown> | undefined;
  const ref = head?.ref;
  return typeof ref === "string" && ref.length > 0 ? ref : null;
}

function pullRequestMatchesBranch(
  pr: Record<string, unknown>,
  branch: string,
): boolean {
  const headRef = headRefFromListItem(pr);
  return headRef === branch;
}

function toCreatedPullRequest(
  pr: Record<string, unknown>,
): CreatedPullRequest | null {
  const htmlUrl = pickString(pr, ["html_url", "htmlUrl", "url", "URL"]);
  const number =
    pickNumber(pr, ["number", "pullNumber"]) ?? pullNumberFromUrl(htmlUrl);
  if (!number || !htmlUrl) return null;
  return { number, htmlUrl };
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

function extractPullRequestList(result: unknown): Record<string, unknown>[] {
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

async function listOpenPullRequests(
  client: GithubMcpClient,
  args: { owner: string; repo: string; head?: string },
): Promise<Record<string, unknown>[]> {
  const result = await client.callTool({
    name: "list_pull_requests",
    arguments: {
      owner: args.owner,
      repo: args.repo,
      state: "open",
      ...(args.head ? { head: args.head } : {}),
      perPage: 30,
    },
  });

  assertGithubToolSuccess(result);
  return extractPullRequestList(result);
}

export async function findOpenPullRequestForBranch(
  client: GithubMcpClient,
  args: {
    owner: string;
    repo: string;
    branch: string;
  },
): Promise<CreatedPullRequest | null> {
  const headFilters = [`${args.owner}:${args.branch}`, args.branch];

  for (const head of headFilters) {
    const prs = await listOpenPullRequests(client, {
      owner: args.owner,
      repo: args.repo,
      head,
    });
    const match = prs.find((pr) => pullRequestMatchesBranch(pr, args.branch));
    const created = match ? toCreatedPullRequest(match) : null;
    if (created) return created;
  }

  const prs = await listOpenPullRequests(client, {
    owner: args.owner,
    repo: args.repo,
  });
  const match = prs.find((pr) => pullRequestMatchesBranch(pr, args.branch));
  return match ? toCreatedPullRequest(match) : null;
}

export async function createPullRequest(
  client: GithubMcpClient,
  args: {
    owner: string;
    repo: string;
    title: string;
    body?: string;
    head: string;
    base: string;
  },
): Promise<CreatedPullRequest> {
  const result = await client.callTool({
    name: "create_pull_request",
    arguments: {
      owner: args.owner,
      repo: args.repo,
      title: args.title,
      body: args.body,
      head: args.head,
      base: args.base,
    },
  });

  return parseCreatedPullRequestResult(result);
}

/** Returns an open PR for the branch, or creates one if none exists. */
export async function openPullRequestForBranch(
  client: GithubMcpClient,
  args: OpenPullRequestArgs,
): Promise<CreatedPullRequest> {
  const existing = await findOpenPullRequestForBranch(client, {
    owner: args.owner,
    repo: args.repo,
    branch: args.branch,
  });
  if (existing) return existing;

  return createPullRequest(client, {
    owner: args.owner,
    repo: args.repo,
    title: args.title,
    body: args.body,
    head: args.branch,
    base: args.base,
  });
}

export async function squashMergePullRequest(
  client: GithubMcpClient,
  args: {
    owner: string;
    repo: string;
    pullNumber: number;
    commitTitle?: string;
  },
): Promise<MergedPullRequest> {
  const result = await client.callTool({
    name: "merge_pull_request",
    arguments: {
      owner: args.owner,
      repo: args.repo,
      pullNumber: args.pullNumber,
      merge_method: "squash",
      ...(args.commitTitle ? { commit_title: args.commitTitle } : {}),
    },
  });

  assertGithubToolSuccess(result);

  const data = extractToolJson<{ merged?: boolean; message?: string }>(result);
  if (data?.merged === false) {
    throw new Error(data.message ?? "Failed to merge pull request");
  }

  return {
    merged: true,
    message: data?.message ?? "Pull request merged",
  };
}
