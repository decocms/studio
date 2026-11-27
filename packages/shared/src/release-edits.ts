import { z } from "zod";
import { type Release, ReleaseSchema } from "./sdk/types/virtual-mcp";

/**
 * Edits to a project's draft list (`metadata.releases`). The server applies
 * them to the stored list under a row lock (`VIRTUAL_MCP_RELEASE_EDIT`), so an
 * editor's tab with an old copy of the list can't write that copy back. The
 * web applies the same edit to its cache for an optimistic update.
 *
 * Every edit returns `current` unchanged when it has nothing to do, so a
 * repeated edit (two tabs, an effect re-running) neither duplicates a draft
 * nor writes.
 */
export const ReleaseEditSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), release: ReleaseSchema }),
  z.object({ op: z.literal("add-pull-request"), release: ReleaseSchema }),
  z.object({ op: z.literal("rename"), branch: z.string(), name: z.string() }),
  z.object({ op: z.literal("remove"), branch: z.string() }),
  z.object({ op: z.literal("mark-sandbox"), branch: z.string() }),
]);

export type ReleaseEdit = z.infer<typeof ReleaseEditSchema>;

export function applyReleaseEdit(
  current: Release[],
  edit: ReleaseEdit,
): Release[] {
  switch (edit.op) {
    case "add":
      return addRelease(current, edit.release);
    case "add-pull-request":
      return addPullRequestRelease(current, edit.release);
    case "rename":
      return renameReleaseIn(current, edit.branch, edit.name);
    case "remove":
      return removeRelease(current, edit.branch);
    case "mark-sandbox":
      return markReleaseSandbox(current, edit.branch);
  }
}

export function addRelease(current: Release[], release: Release): Release[] {
  return current.some((r) => r.branch === release.branch)
    ? current
    : [...current, release];
}

export function removeRelease(current: Release[], branch: string): Release[] {
  return current.some((r) => r.branch === branch)
    ? current.filter((r) => r.branch !== branch)
    : current;
}

/**
 * Name `release` as a pull request draft: a CMS draft rendered on the pull
 * request's deploy preview. An existing draft of the branch is turned into
 * one, keeping its name and color: picking the pull request is the newer
 * intent.
 */
export function addPullRequestRelease(
  current: Release[],
  release: Release,
): Release[] {
  const pullRequest = {
    runtime: "cms" as const,
    preview: "pull-request" as const,
  };
  const target = current.find((r) => r.branch === release.branch);
  if (!target) return [...current, { ...release, ...pullRequest }];
  if (target.runtime === "cms" && target.preview === "pull-request") {
    return current;
  }
  return current.map((r) => (r === target ? { ...r, ...pullRequest } : r));
}

/** One-way (pull request drafts excepted): a coding session may leave code. */
export function markReleaseSandbox(
  current: Release[],
  branch: string,
): Release[] {
  const target = current.find((r) => r.branch === branch);
  if (
    !target ||
    target.runtime === "sandbox" ||
    target.preview === "pull-request"
  ) {
    return current;
  }
  return current.map((r) =>
    r === target ? { ...r, runtime: "sandbox" as const } : r,
  );
}

export function renameReleaseIn(
  current: Release[],
  branch: string,
  name: string,
): Release[] {
  const target = current.find((r) => r.branch === branch);
  if (!target || target.name === name) return current;
  return current.map((r) => (r === target ? { ...r, name } : r));
}
