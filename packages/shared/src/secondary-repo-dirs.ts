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

import {
  repositoryBindingKey,
  sameRepositoryBinding,
} from "./repository-binding";
export interface SecondaryRepoRef {
  owner: string;
  name: string;
  url: string;
  repositoryId?: string;
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
  const useOwner = repos.map((r) => shared.has(r.name.toLowerCase()));
  const candidateOf = (i: number) => {
    const r = repos[i]!;
    return sanitize(
      useOwner[i] ? `${r.owner}-${r.name}` : r.name,
    ).toLowerCase();
  };

  // An owner-qualified name can itself collide with a sibling's bare name; escalate the losing side until stable, bounded by repos.length.
  for (let pass = 0; pass < repos.length; pass++) {
    const seen = new Map<string, number>();
    let changed = false;
    for (let i = 0; i < repos.length; i++) {
      const candidate = candidateOf(i);
      const prior = seen.get(candidate);
      if (prior !== undefined) {
        if (!useOwner[i]) {
          useOwner[i] = true;
          changed = true;
        }
        if (!useOwner[prior]) {
          useOwner[prior] = true;
          changed = true;
        }
      }
      seen.set(candidate, i);
    }
    if (!changed) break;
  }

  const names = repos.map((r, i) =>
    sanitize(useOwner[i] ? `${r.owner}-${r.name}` : r.name),
  );
  // Identical namespaces on different hosts are distinct checkouts.
  const counts = new Map<string, number>();
  for (const name of names)
    counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);
  const qualified = names.map((name, i) => {
    if (counts.get(name.toLowerCase()) === 1) return name;
    const host = new URL(repos[i]!.url).host;
    return sanitize(`${host}-${name}`);
  });
  // A host-qualified name can also be another checkout's bare name. Reserve
  // non-colliding destinations first, then allocate deterministic suffixes.
  const occurrences = new Map<string, number>();
  for (const name of qualified)
    occurrences.set(
      name.toLowerCase(),
      (occurrences.get(name.toLowerCase()) ?? 0) + 1,
    );
  const used = new Set(
    qualified
      .filter((name) => occurrences.get(name.toLowerCase()) === 1)
      .map((name) => name.toLowerCase()),
  );
  const collisions = qualified
    .map((_, index) => index)
    .filter((index) => occurrences.get(qualified[index]!.toLowerCase()) !== 1)
    .sort((left, right) =>
      (repositoryBindingKey(repos[left]!) ?? "").localeCompare(
        repositoryBindingKey(repos[right]!) ?? "",
      ),
    );
  for (const index of collisions) {
    const base = qualified[index]!;
    let suffix = 1;
    let name = `${base}-${suffix}`;
    while (used.has(name.toLowerCase())) name = `${base}-${++suffix}`;
    used.add(name.toLowerCase());
    qualified[index] = name;
  }
  return qualified;
}

/** This repo's directory name within `all`, or null when it is not in the set. */
export function secondaryRepoDirName(
  all: SecondaryRepoRef[],
  repo: SecondaryRepoRef,
): string | null {
  const index = all.findIndex((candidate) =>
    sameRepositoryBinding(candidate, repo),
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
