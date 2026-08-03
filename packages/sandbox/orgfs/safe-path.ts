import path from "node:path";

/**
 * Resolves `userPath` relative to `baseDir`, then enforces that the result
 * stays inside `workspaceRoot`. Returns null on escape.
 *
 * Used by the org-fs mount manager to clamp a relayed mount target into the
 * shared workspace — a config-file-driven trust boundary, so the escape cases
 * are covered by tests.
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
