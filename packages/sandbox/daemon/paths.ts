import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Resolves the package-manager root against `repoDir`.
 * `pmPath` may be absolute or relative (e.g. "mcp" meaning `<repoDir>/mcp`).
 * Falls back to `repoDir` when `pmPath` is absent.
 */
export function resolvePmRoot(repoDir: string, pmPath?: string): string {
  if (!pmPath) return repoDir;
  return path.isAbsolute(pmPath) ? pmPath : path.join(repoDir, pmPath);
}

/** Returns the tee log path for a named app script (e.g. "dev", "install", "clone"). */
export function appLogPath(logsDir: string, name: string): string {
  return path.join(logsDir, "app", name);
}

/** Returns true when `<repoDir>/.git` exists — i.e. a repo is already checked out. */
export function hasGitRepo(repoDir: string): boolean {
  return existsSync(path.join(repoDir, ".git"));
}

/**
 * Resolves `userPath` relative to `baseDir`, then enforces that the result
 * stays inside `workspaceRoot`. Returns null on escape.
 *
 * `baseDir` is typically the repo (`<workspaceRoot>/app`) so the LLM's
 * relative paths match what `bash` sees as cwd. The clamp is `workspaceRoot`
 * so paths like `../tmp/app/dev` (siblings of the repo, still inside the
 * workspace) resolve correctly.
 */
export function safePath(
  workspaceRoot: string,
  baseDir: string,
  userPath: string,
): string | null {
  const resolved = path.resolve(baseDir, userPath);
  if (!resolved.startsWith(`${workspaceRoot}/`) && resolved !== workspaceRoot) {
    return null;
  }
  return resolved;
}
