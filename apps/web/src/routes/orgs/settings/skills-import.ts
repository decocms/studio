/**
 * Pure mapping from a picked folder onto `home/skills/<slug>/…`, split from the
 * page so it can be unit-tested without the route's React module graph.
 */

import { parseSkillMd } from "@decocms/shared/harness/skill-md";
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import type { OrgFsSkillCatalogEntry } from "@/hooks/use-org-fs";

/** One PUT per file, so a stray `node_modules` would fan out to thousands. */
export const MAX_IMPORT_FILES = 200;

const SKIPPED_DIRS = new Set(["node_modules", "__pycache__"]);

/** A picked file's path relative to the folder root the user chose. */
export function relativePath(file: File): string {
  const [, ...rest] = file.webkitRelativePath.split("/");
  return rest.length > 0 ? rest.join("/") : file.name;
}

/** Drop what a skill folder never means to ship: tooling dirs and dotfiles. */
export function importable(file: File): boolean {
  return relativePath(file)
    .split("/")
    .every((segment) => !segment.startsWith(".") && !SKIPPED_DIRS.has(segment));
}

export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skill"
  );
}

/**
 * Group the picked files by destination directory: the upload endpoint takes
 * one directory plus files whose own `name` completes the path, so nested
 * files must be grouped rather than flattened (which would collapse
 * `references/style.md` onto the root).
 */
export function groupByDestination(
  files: File[],
  slug: string,
): Map<string, File[]> {
  const groups = new Map<string, File[]>();
  for (const file of files) {
    const segments = relativePath(file).split("/");
    segments.pop();
    const dir = ["skills", slug, ...segments].join("/");
    groups.set(dir, [...(groups.get(dir) ?? []), file]);
  }
  return groups;
}

/**
 * Upload every destination group concurrently.
 *
 * `allSettled`, not `all`: `all` rejects on the first failure while the rest
 * are still in flight, resolving the caller's catch (and its catalog refresh)
 * before those PUTs land — the same trap `useOrgFsMutations` avoids per-file.
 */
export async function uploadAllGroups(
  groups: Map<string, File[]>,
  put: (input: { dir: string; files: File[] }) => Promise<unknown>,
): Promise<void> {
  const results = await Promise.allSettled(
    [...groups].map(([dir, files]) => put({ dir, files })),
  );
  const failure = results.find(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  if (failure) throw failure.reason;
}

/**
 * The catalog row the server will return for a just-imported skill, built from
 * the same `SKILL.md` bytes it will parse — so the optimistic card carries the
 * skill's real name and description instead of a placeholder that changes
 * under the user once the refetch lands.
 */
export function optimisticEntry(
  slug: string,
  skillMd: string,
): OrgFsSkillCatalogEntry {
  const meta = parseSkillMd(skillMd);
  const path = `skills/${slug}`;
  return {
    id: `home/${path}`,
    name: meta.name ?? slug,
    description: meta.description,
    // Wire token, not a path — it just happens to spell the volume too.
    source: "home",
    volume: HOME_MOUNT_PATH,
    path,
    sandboxPath: `org/${HOME_MOUNT_PATH}/${path}`,
  };
}
