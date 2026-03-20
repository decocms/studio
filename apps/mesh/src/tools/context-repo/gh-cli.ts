/**
 * GitHub CLI Access Layer
 *
 * Uses the `gh` CLI for GitHub operations. Only works when gh is installed
 * and authenticated locally (gh auth login).
 *
 * Security:
 * - All subprocess calls use array args (never shell strings)
 * - Owner/repo validated against strict regex
 * - Clone paths are org-scoped to prevent cross-org collisions
 */

import { join } from "node:path";
import { homedir } from "node:os";

const VALID_NAME_RE = /^[a-zA-Z0-9._-]+$/;
const REPOS_BASE = join(homedir(), "deco", "repos");

/** Validate a GitHub owner or repo name */
function validateName(value: string, label: string): string {
  if (!VALID_NAME_RE.test(value)) {
    throw new Error(
      `Invalid GitHub ${label}: "${value}". Only alphanumeric, dots, hyphens, and underscores allowed.`,
    );
  }
  return value;
}

/** Check if gh CLI is available and authenticated */
export async function checkGhAccess(): Promise<{
  available: boolean;
  user?: string;
}> {
  try {
    const proc = Bun.spawn(
      ["gh", "auth", "status", "--hostname", "github.com"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return { available: false };
    // Parse username from output like "Logged in to github.com account username"
    const match = stderr.match(/account\s+(\S+)/);
    return { available: true, user: match?.[1] };
  } catch {
    return { available: false };
  }
}

/** Get the local clone path for a repo (org-scoped) */
export function getRepoPath(
  orgId: string,
  owner: string,
  repo: string,
): string {
  validateName(owner, "owner");
  validateName(repo, "repo");
  return join(REPOS_BASE, orgId, owner, repo);
}

/** Clone or pull a GitHub repo. Returns the local path. */
export async function cloneOrPull(
  orgId: string,
  owner: string,
  repo: string,
  branch: string = "main",
): Promise<{ path: string; headCommit: string }> {
  validateName(owner, "owner");
  validateName(repo, "repo");
  // Branch can have slashes
  if (!/^[a-zA-Z0-9._\/-]+$/.test(branch)) {
    throw new Error(`Invalid branch name: "${branch}"`);
  }

  const repoPath = getRepoPath(orgId, owner, repo);
  const fullName = `${owner}/${repo}`;

  // Check if already cloned
  const exists = await Bun.file(join(repoPath, ".git", "HEAD")).exists();

  if (exists) {
    // Pull latest
    const proc = Bun.spawn(
      ["git", "-C", repoPath, "pull", "--ff-only", "origin", branch],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await proc.exited;
  } else {
    // Create parent directory
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(REPOS_BASE, orgId, owner), { recursive: true });

    // Shallow clone using gh CLI (handles auth for both HTTPS and SSH)
    const proc = Bun.spawn(
      [
        "gh",
        "repo",
        "clone",
        fullName,
        repoPath,
        "--",
        "--depth",
        "1",
        "--branch",
        branch,
        "--single-branch",
        "-c",
        "core.hooksPath=/dev/null",
        "--no-recurse-submodules",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Failed to clone ${fullName}: ${stderr.trim()}`);
    }
  }

  // Get HEAD commit SHA
  const shaProc = Bun.spawn(["git", "-C", repoPath, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const sha = (await new Response(shaProc.stdout).text()).trim();
  await shaProc.exited;

  return { path: repoPath, headCommit: sha };
}

/** List changed files between two commits */
export async function diffFiles(
  repoPath: string,
  oldCommit: string,
  newCommit: string,
): Promise<{ added: string[]; modified: string[]; deleted: string[] }> {
  const proc = Bun.spawn(
    [
      "git",
      "-C",
      repoPath,
      "diff",
      "--name-status",
      `${oldCommit}..${newCommit}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = (await new Response(proc.stdout).text()).trim();
  await proc.exited;

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [status, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t");
    if (status === "A") added.push(filePath);
    else if (status === "M") modified.push(filePath);
    else if (status === "D") deleted.push(filePath);
  }

  return { added, modified, deleted };
}

/** List all files in the repo (for initial index) */
export async function listAllFiles(repoPath: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "-C", repoPath, "ls-files"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return output ? output.split("\n") : [];
}
