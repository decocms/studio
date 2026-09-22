import { type RepoRef, splitOwnerName } from "@decocms/shared/git-providers";

/** Cap on siblings per token, and so on manifest reads per clone. */
const MAX_SIBLINGS = 20;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Same-owner repos named by this manifest's `git:` dependencies, either URL form. */
function siblingsIn(
  pubspec: string,
  ref: Pick<RepoRef, "host" | "path">,
): string[] {
  const { owner } = splitOwnerName(ref);
  const host = escapeRegExp(ref.host);
  const pattern = new RegExp(
    `(?:https?://(?:[^@\\s/]*@)?${host}/|git@${host}:)${escapeRegExp(owner)}/([A-Za-z0-9._-]+)`,
    "gi",
  );
  return [...pubspec.matchAll(pattern)].flatMap(
    (m) => m[1]?.replace(/\.git$/i, "") || [],
  );
}

/**
 * Every same-owner repository a checkout of `ref` needs, walked transitively.
 *
 * A GitHub App installation token is minted for named repositories and no
 * others (`tokenForRepo`), so without this a private `git:` dependency in a
 * sibling repository 404s — and covering only the DIRECT dependencies fails
 * one layer later, because `pub get` resolves the whole graph. Another owner
 * is a different installation, which no token minted here can reach.
 *
 * One read per repository discovered, breadth-first, capped. Every read is
 * best-effort: no manifest, a 404, a repository outside the grant, and a
 * transient failure all mean "nothing further down this branch", which narrows
 * the token back rather than failing the clone.
 *
 * ponytail: reads default branches, since that is what the caller minting a
 * clone token can resolve — a dependency ADDED on the working branch is not in
 * the token. Thread the branch through if that comes up.
 */
export async function manifestSiblingRepos(
  readFile: (repoPath: string, path: string) => Promise<string | null>,
  ref: Pick<RepoRef, "host" | "path">,
): Promise<string[]> {
  const { owner, name } = splitOwnerName(ref);
  const found = new Set<string>();
  const queue = [ref.path];
  while (queue.length > 0 && found.size < MAX_SIBLINGS) {
    const repoPath = queue.shift();
    if (!repoPath) break;
    const pubspec = await readFile(repoPath, "pubspec.yaml").catch(() => null);
    if (!pubspec) continue;
    for (const sibling of siblingsIn(pubspec, ref)) {
      if (sibling === name || found.has(sibling)) continue;
      if (found.size >= MAX_SIBLINGS) break;
      found.add(sibling);
      queue.push(`${owner}/${sibling}`);
    }
  }
  return [...found];
}
