import type { Release } from "@decocms/shared/sdk/types";
import type { ThreadRuntime } from "@decocms/shared/thread/session-runtime";

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
