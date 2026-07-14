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
  // A plain `startsWith(workspaceRoot + "/")` check is POSIX-only: on win32
  // path.resolve/path.join emit backslash-separated paths (and drive
  // letters), so a hardcoded "/" separator never matches and every request
  // gets rejected. `path.relative` is platform-correct: it returns a path
  // that starts with ".." (or is itself absolute, e.g. a different drive
  // letter on win32) whenever `resolved` falls outside `workspaceRoot` —
  // regardless of which separator the platform uses.
  const rel = path.relative(workspaceRoot, resolved);
  if (
    rel !== "" &&
    (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
  ) {
    return null;
  }
  return resolved;
}
