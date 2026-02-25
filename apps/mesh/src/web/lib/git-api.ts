import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
}

export interface ChangedFile {
  status: "M" | "A" | "D" | "?" | "R";
  path: string;
}

/**
 * Run a bash command via MCP connection and extract structured result.
 */
async function bash(
  client: Client,
  cmd: string,
  timeout = 30000,
): Promise<BashResult> {
  const result = await client.callTool({
    name: "bash",
    arguments: { cmd, timeout },
  });
  // structuredContent is the parsed { stdout, stderr, exitCode }
  if (
    result.structuredContent &&
    typeof result.structuredContent === "object"
  ) {
    return result.structuredContent as BashResult;
  }
  // Fallback: parse from text content
  const text =
    result.content &&
    Array.isArray(result.content) &&
    result.content[0]?.type === "text"
      ? (result.content[0] as { text: string }).text
      : "{}";
  return JSON.parse(text) as BashResult;
}

/**
 * Get current branch name.
 */
export async function gitBranch(client: Client): Promise<string> {
  const r = await bash(client, "git branch --show-current");
  return r.stdout.trim();
}

/**
 * Get list of changed files from git status.
 */
export async function gitStatus(client: Client): Promise<ChangedFile[]> {
  const r = await bash(client, "git status --porcelain");
  if (!r.stdout.trim()) return [];
  return r.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      // git status --porcelain format: XY<space>path
      // But MCP bash output may have inconsistent whitespace,
      // so split on first space-then-non-space transition.
      const match = line.match(/^(.{1,2})\s+(.+)$/);
      const code = (match?.[1] ?? line.slice(0, 2)).trim();
      const path = match?.[2] ?? line.slice(3);
      const status =
        code === "M" || code === "MM"
          ? "M"
          : code === "A" || code === "AM"
            ? "A"
            : code === "D"
              ? "D"
              : code.startsWith("R")
                ? "R"
                : "?";
      return { status: status as ChangedFile["status"], path };
    });
}

/**
 * Get unified diff of all unstaged + staged changes.
 */
export async function gitDiff(client: Client): Promise<string> {
  // Show both staged and unstaged changes
  const [unstaged, staged] = await Promise.all([
    bash(client, "git diff"),
    bash(client, "git diff --cached"),
  ]);
  return [unstaged.stdout, staged.stdout].filter(Boolean).join("\n");
}

/**
 * Get recent commit history.
 */
export async function gitLog(client: Client, limit = 10): Promise<GitCommit[]> {
  const r = await bash(client, `git log -${limit} --format="%H|%h|%an|%aI|%s"`);
  if (r.exitCode !== 0 || !r.stdout.trim()) return [];
  return r.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, author, date, ...msgParts] = line.split("|");
      return {
        hash: hash ?? "",
        shortHash: shortHash ?? "",
        author: author ?? "",
        date: date ?? "",
        message: msgParts.join("|"),
      };
    });
}

/**
 * Stage all changes and commit.
 */
export async function gitCommit(
  client: Client,
  message: string,
): Promise<BashResult> {
  const escaped = message.replace(/'/g, "'\\''");
  return bash(client, `git add -A && git commit -m '${escaped}'`);
}

/**
 * List all local branches.
 */
export async function gitBranchList(client: Client): Promise<string[]> {
  const r = await bash(client, "git branch --format='%(refname:short)'");
  if (!r.stdout.trim()) return [];
  return r.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((b) => b.trim());
}

/**
 * Switch to an existing branch.
 */
export async function gitCheckoutBranch(
  client: Client,
  name: string,
): Promise<BashResult> {
  const sanitized = name.replace(/[^a-zA-Z0-9/_.-]/g, "-");
  return bash(client, `git checkout ${sanitized}`);
}

/**
 * Create and switch to a new branch.
 */
export async function gitCheckoutNewBranch(
  client: Client,
  name: string,
): Promise<BashResult> {
  const sanitized = name.replace(/[^a-zA-Z0-9/_-]/g, "-");
  return bash(client, `git checkout -b ${sanitized}`);
}
