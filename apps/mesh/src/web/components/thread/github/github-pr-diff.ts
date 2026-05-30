import type { GitDiffResult } from "./sandbox-git-api.ts";
import { extractToolJson } from "./extract-tool-json.ts";
import type { PrFile } from "./use-pr-data.ts";

type GithubMcpClient = {
  callTool: (req: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>;
};

const FILE_FETCH_CONCURRENCY = 10;

export function decodeGithubFileContent(result: unknown): string | null {
  const typed = result as {
    isError?: boolean;
    content?: Array<{
      type?: string;
      text?: string;
      resource?: { text?: string };
    }>;
  };
  if (typed.isError) return null;
  const resourceBlock = typed.content?.find((c) => c.type === "resource");
  const raw = resourceBlock?.resource?.text ?? resourceBlock?.text;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string") return parsed;
    if (
      parsed &&
      typeof parsed === "object" &&
      "content" in parsed &&
      typeof (parsed as { content?: unknown }).content === "string"
    ) {
      return (parsed as { content: string }).content;
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

async function getFileAtRef(
  client: GithubMcpClient,
  args: { owner: string; repo: string; path: string },
  ref: { sha?: string; ref?: string },
): Promise<string | null> {
  try {
    const result = await client.callTool({
      name: "get_file_contents",
      arguments: {
        owner: args.owner,
        repo: args.repo,
        path: args.path,
        ...ref,
      },
    });
    return decodeGithubFileContent(result);
  } catch {
    return null;
  }
}

function parsePrFiles(result: unknown): PrFile[] {
  const arr = extractToolJson<Record<string, unknown>[]>(result);
  if (!Array.isArray(arr)) return [];
  return arr.map((f): PrFile => {
    const additions = Number(f.additions ?? 0);
    const changes = Number(f.changes ?? additions);
    const deletions = Number(f.deletions ?? Math.max(0, changes - additions));
    return {
      filename: String(f.filename ?? ""),
      status: (f.status as PrFile["status"] | undefined) ?? "modified",
      additions,
      deletions,
      blobUrl: typeof f.blob_url === "string" ? f.blob_url : null,
    };
  });
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await fn(items[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
}

/**
 * Fallback when the sandbox shallow clone can't resolve merge-base: load full
 * file blobs from GitHub at the PR head and merge-base (when known).
 */
export async function fetchGithubPrDiff(
  client: GithubMcpClient,
  args: {
    owner: string;
    repo: string;
    pullNumber: number;
    base: string;
    headSha: string;
    mergeBaseSha?: string;
  },
): Promise<GitDiffResult> {
  const filesResult = await client.callTool({
    name: "pull_request_read",
    arguments: {
      method: "get_files",
      owner: args.owner,
      repo: args.repo,
      pullNumber: args.pullNumber,
      perPage: 100,
    },
  });

  const files = parsePrFiles(filesResult).filter((f) => f.filename.length > 0);
  const diffs: GitDiffResult["diffs"] = {};
  const fromRef = args.mergeBaseSha
    ? { sha: args.mergeBaseSha }
    : { ref: args.base };

  await mapWithConcurrency(files, FILE_FETCH_CONCURRENCY, async (file) => {
    const path = file.filename;
    if (file.status === "added") {
      diffs[path] = {
        from: null,
        to: await getFileAtRef(
          client,
          { owner: args.owner, repo: args.repo, path },
          { sha: args.headSha },
        ),
      };
      return;
    }
    if (file.status === "removed") {
      diffs[path] = {
        from: await getFileAtRef(
          client,
          { owner: args.owner, repo: args.repo, path },
          fromRef,
        ),
        to: null,
      };
      return;
    }

    const [from, to] = await Promise.all([
      getFileAtRef(
        client,
        { owner: args.owner, repo: args.repo, path },
        fromRef,
      ),
      getFileAtRef(
        client,
        { owner: args.owner, repo: args.repo, path },
        { sha: args.headSha },
      ),
    ]);
    diffs[path] = { from, to };
  });

  return { diffs };
}

export function countGitDiffFiles(
  diff: GitDiffResult | null | undefined,
): number {
  return diff ? Object.keys(diff.diffs).length : 0;
}
