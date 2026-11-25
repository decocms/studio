/**
 * What REPOSITORY_COMMIT_FILES refuses to write (and REPOSITORY_READ_FILE to
 * read), as pure checks: the branch name, each path, a commit sha and the size
 * of a call. Kept apart from the tools so they are testable without a
 * repository.
 */

/** Per call: enough for a post and its assets, small enough to review. */
export const MAX_COMMIT_FILES = 50;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

/** A control character (U+0000–U+001F, U+007F): never part of a name or path. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Why `name` cannot be a branch this tool writes, or null. A subset of git's
 * ref rules (`git check-ref-format`), stricter where that costs nothing.
 */
export function branchNameIssue(name: string): string | null {
  if (!name || name.length > 255) return "must be 1 to 255 characters";
  if (/[\s~^:?*[\\]/.test(name) || hasControl(name))
    return "has a space or a character git does not allow (~ ^ : ? * [ \\)";
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/"))
    return "cannot start with - or /, or end with /";
  if (name.includes("..") || name.includes("//") || name.includes("@{"))
    return "cannot contain .., // or @{";
  if (name.endsWith(".") || name.endsWith(".lock"))
    return "cannot end with . or .lock";
  if (name.split("/").some((part) => part.startsWith(".")))
    return "no part of it can start with .";
  return null;
}

/** Why `path` is not a relative, normalized path in a repository, or null. */
export function pathShapeIssue(path: string): string | null {
  if (!path || path.length > 1024) return "must be 1 to 1024 characters";
  if (path.includes("\\") || hasControl(path))
    return "has a backslash or a control character";
  if (path.startsWith("/")) return "must be relative to the repository root";
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    return "must not have empty, . or .. segments";
  return null;
}

/**
 * Why `path` cannot be written, or null: a well-shaped path, never `.git/` or
 * `.github/`. CI definitions run with the repository's secrets, so changing
 * them is not a content edit.
 */
function filePathIssue(path: string): string | null {
  const shape = pathShapeIssue(path);
  if (shape) return shape;
  const parts = path.split("/");
  if (parts.includes(".git")) return "must not be inside .git/";
  if (parts[0] === ".github")
    return "must not be inside .github/ (CI runs with the repository's secrets)";
  return null;
}

/** A full commit id: 40 hex characters (GitHub, GitLab and Bitbucket all use SHA-1 ids). */
export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

type FileInput =
  | { path: string; content: string }
  | { path: string; deleted: true };

/** Every problem with a set of files, one line each; empty when it is fine. */
export function filesIssues(files: readonly FileInput[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const issue = filePathIssue(file.path);
    if (issue) issues.push(`${file.path}: ${issue}`);
    if (seen.has(file.path)) issues.push(`${file.path}: listed twice`);
    seen.add(file.path);
    if ("content" in file) {
      const bytes = Buffer.byteLength(file.content);
      total += bytes;
      if (bytes > MAX_FILE_BYTES)
        issues.push(`${file.path}: over ${MAX_FILE_BYTES} bytes`);
    }
  }
  if (total > MAX_TOTAL_BYTES)
    issues.push(`the files add up to over ${MAX_TOTAL_BYTES} bytes`);
  return issues;
}
