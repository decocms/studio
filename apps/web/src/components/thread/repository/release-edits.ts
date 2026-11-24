import type { Release } from "@decocms/shared/sdk/types";
import type { ThreadRuntime } from "@decocms/shared/thread/session-runtime";

/**
 * Pure edits to the `metadata.releases` array. Kept separate from
 * {@link ./use-releases.ts} so they're unit-testable without React/SDK, and so
 * the read-modify-write serialization there composes over well-defined steps.
 *
 * Add is idempotent by branch: a double-fire (two tabs, or the shell's
 * auto-name effect re-running) can't duplicate a draft.
 */
export function addRelease(current: Release[], release: Release): Release[] {
  return current.some((r) => r.branch === release.branch)
    ? current
    : [...current, release];
}

export function removeRelease(current: Release[], branch: string): Release[] {
  return current.filter((r) => r.branch !== branch);
}

/**
 * Name `release` as a pull request draft: a CMS draft rendered on the pull
 * request's deploy preview. Idempotent by branch like {@link addRelease}, but
 * an existing draft of the branch is turned into one, keeping its name and
 * color: picking the pull request is the newer intent.
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
  return current.map((r) => (r.branch === branch ? { ...r, name } : r));
}

/** A draft's runtime. An unstamped draft (made before stamps existed, or by a
 *  path that didn't stamp it) takes the project's default, per `ReleaseSchema`:
 *  on a project without Fast Preview it is code, not content. */
export function releaseRuntime(
  release: Release,
  projectDefault: ThreadRuntime,
): ThreadRuntime {
  return release.runtime ?? projectDefault;
}

/** Content drafts first, then coding (`sandbox`) drafts, each in list order. */
export function groupReleasesByRuntime(
  releases: Release[],
  projectDefault: ThreadRuntime,
): {
  content: Release[];
  code: Release[];
} {
  const isCode = (r: Release) =>
    releaseRuntime(r, projectDefault) === "sandbox";
  return {
    content: releases.filter((r) => !isCode(r)),
    code: releases.filter(isCode),
  };
}
