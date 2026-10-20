/**
 * Repository-path arithmetic shared by the providers that address trees by
 * directory (GitLab, Bitbucket) rather than by object sha (GitHub). Pure —
 * no provider vocabulary, no I/O.
 */

/** Repo-relative directory of `path`; `""` for a file at the repo root. */
export function directoryOf(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? "" : normalized.slice(0, slash);
}

/**
 * Paths bucketed by the directory they live in, deduplicated, insertion
 * ordered. One bucket is one tree listing, which is what keeps a lookup of a
 * caller-known path set scaling with the set instead of with repo size.
 */
export function groupPathsByDirectory(
  paths: readonly string[],
): Map<string, string[]> {
  const byDir = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const raw of paths) {
    const path = raw.replace(/^\/+/, "");
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    const dir = directoryOf(path);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(path);
    else byDir.set(dir, [path]);
  }
  return byDir;
}

/** `<packagePath>/.deco`, or `.deco` for a single-project repo. */
export function decoDirFor(packagePath: string | null): string {
  return packagePath ? `${packagePath}/.deco` : ".deco";
}
