/**
 * Sibling repositories that a repository's dependency manifest points at.
 *
 * A GitHub App installation token is minted for named repositories and no
 * others (see `tokenForRepo`), so a checkout of repo A cannot fetch a
 * dependency that lives in repo B: `flutter pub get` 404s on it even when the
 * App is installed on B and the org granted both. The manifest is the only
 * place that says which repositories a checkout actually needs, so it is what
 * widens the mint — by exactly those repositories and nothing else.
 *
 * Dart/Flutter only for now, because `pubspec.yaml`'s `git:` dependencies are
 * the case this exists for. Another ecosystem that references private repos
 * the same way (a Go module on a private host, a git-referenced npm dep) adds
 * its filename and parser here rather than a second mechanism.
 */

import { type RepoRef, splitOwnerName } from "@decocms/shared/git-providers";

const PUBSPEC_PATH = "pubspec.yaml";

/**
 * Cap on how many siblings widen one token, and so on how many manifests the
 * walk reads. GitHub allows 500 repositories per token, but a graph naming
 * dozens of same-owner repositories is a signal something is off, not a reason
 * to hand a sandbox a token that reaches all of them — or to spend dozens of
 * API calls per clone finding out.
 */
const MAX_SIBLINGS = 20;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Repository names named by `pubspec.yaml`'s git dependencies, restricted to
 * this repository's own host and owner.
 *
 * The owner filter is not a policy choice: an installation token belongs to one
 * account, so a dependency under a different owner is in a different
 * installation and no token minted here can ever reach it.
 *
 * Matching is over the whole file rather than a parsed YAML tree — `url:` under
 * `git:` is the only place a pubspec carries a repository URL, and a regex needs
 * no YAML dependency to find it in either the HTTPS or the SSH form.
 */
export function pubspecSiblingRepos(
  pubspec: string,
  ref: Pick<RepoRef, "host" | "path">,
): string[] {
  const { owner, name } = splitOwnerName(ref);
  const host = escapeRegExp(ref.host);
  const account = escapeRegExp(owner);
  const pattern = new RegExp(
    `(?:https?://(?:[^@\\s/]*@)?${host}/|git@${host}:)${account}/([A-Za-z0-9._-]+)`,
    "gi",
  );
  const seen = new Set<string>();
  const siblings: string[] = [];
  for (const match of pubspec.matchAll(pattern)) {
    const sibling = match[1]?.replace(/\.git$/i, "");
    if (!sibling) continue;
    const key = sibling.toLowerCase();
    // The repository being cloned is already in the mint.
    if (key === name.toLowerCase() || seen.has(key)) continue;
    seen.add(key);
    siblings.push(sibling);
    if (siblings.length === MAX_SIBLINGS) break;
  }
  return siblings;
}

/**
 * Every sibling repository the checkout needs, walked transitively.
 *
 * Transitive because a direct dependency's own manifest names more private
 * repositories, and `pub get` resolves the whole graph: a token covering only
 * the direct dependencies 404s on the next layer down, which is the same
 * failure one step later. Reading a sibling's manifest is possible for the same
 * reason the widening works at all — Studio can mint a token for any repository
 * in the installation; it is the sandbox that gets only one.
 *
 * Bounded by `MAX_SIBLINGS`, which also bounds the API calls: one manifest read
 * per repository discovered, plus the root. Breadth-first, so a cap cuts the
 * deepest layer rather than a whole branch.
 *
 * Best-effort at every read: a repository with no manifest, a 404, a grant that
 * does not cover it, and a transient failure all mean "nothing further down
 * this branch" rather than a failed clone. The narrower token that results is
 * the behaviour from before this existed.
 *
 * ponytail: reads each default branch, because that is what `readFile` without
 * a ref resolves and the caller minting a clone token does not know the branch
 * yet. A private dependency ADDED on the working branch is therefore not in the
 * token — thread the branch through if that case ever comes up.
 */
export async function manifestSiblingRepos(
  readFile: (repoPath: string, path: string) => Promise<string | null>,
  ref: Pick<RepoRef, "host" | "path">,
): Promise<string[]> {
  const { owner } = splitOwnerName(ref);
  const found = new Set<string>();
  const queue = [ref.path];
  while (queue.length > 0 && found.size < MAX_SIBLINGS) {
    const repoPath = queue.shift();
    if (!repoPath) break;
    const pubspec = await readFile(repoPath, PUBSPEC_PATH).catch(() => null);
    if (!pubspec) continue;
    // `ref`, not `repoPath`: only the root is already in the mint.
    for (const sibling of pubspecSiblingRepos(pubspec, ref)) {
      if (found.has(sibling) || found.size >= MAX_SIBLINGS) continue;
      found.add(sibling);
      queue.push(`${owner}/${sibling}`);
    }
  }
  return [...found];
}
