/**
 * Directory names for a sandbox's secondary checkouts.
 *
 * A secondary's name IS a directory under the pod's secondary root, and the
 * daemon refuses one carrying a path separator, so `owner/name` cannot be it.
 * The bare repo name can collide, though: two owners each with a `checkout`
 * must not share one directory, so a colliding set falls back to `owner-name`
 * for every member of that set.
 *
 * This lives here, and not next to either caller, because BOTH have to agree.
 * `TASK_ADD_REPO` names the directory when it adds a repo mid-run, and
 * provisioning names it again when a recreated pod replays the accumulated
 * list. Two rules would put the same repo in two places across a pod restart,
 * and the paths the agent had been using would stop resolving.
 */

export interface SecondaryRepoRef {
  owner: string;
  name: string;
}

/**
 * One directory name per input, in the same order. Deterministic: the answer
 * for a repo depends only on the set it is named alongside.
 */
export function secondaryRepoDirNames(repos: SecondaryRepoRef[]): string[] {
  const shared = new Set(
    repos
      .map((r) => r.name.toLowerCase())
      .filter((name, i, all) => all.indexOf(name) !== i),
  );
  return repos.map((r) =>
    sanitize(
      shared.has(r.name.toLowerCase()) ? `${r.owner}-${r.name}` : r.name,
    ),
  );
}

/** This repo's directory name within `all`, or null when it is not in the set. */
export function secondaryRepoDirName(
  all: SecondaryRepoRef[],
  repo: SecondaryRepoRef,
): string | null {
  const key = `${repo.owner}/${repo.name}`.toLowerCase();
  const index = all.findIndex(
    (r) => `${r.owner}/${r.name}`.toLowerCase() === key,
  );
  return index === -1 ? null : (secondaryRepoDirNames(all)[index] ?? null);
}

/** Bounded to what the daemon accepts: opens on an alphanumeric, no separator. */
function sanitize(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "");
  return cleaned || "repo";
}
