/**
 * Which drafts a view works on, and the threads it may run on.
 *
 * Blog works on its own drafts (`blog-draft-` branches,
 * `@decocms/shared/branch-name`), in the project's runtime like the site's
 * drafts. The views under the site's draft bar (the Site Editor, Experiments
 * and Calendar) never run on a Blog draft, and Blog never runs on a site draft
 * in Fast Preview. Any other view takes whatever thread it is given.
 */

import {
  blogDraftBranchName,
  generateBranchName,
  isBlogDraftBranch,
} from "@decocms/shared/branch-name";
import {
  defaultThreadRuntime,
  readThreadRuntime,
  type ThreadRuntime,
  type VmcpRuntimeMetadata,
} from "@decocms/shared/thread/session-runtime";
import type { Task } from "@/components/chat/task/types";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { threadRuntimeMatches } from "@/lib/thread-runtime-match";

export type DraftKind = "blog" | "site";

const SITE_VIEWS: ReadonlySet<string> = new Set([
  "site-editor",
  "content",
  "code",
  "experiments",
  "calendar",
]);

/** The draft kind of a route's `mainView`, or `null` for a view that has none. */
export function viewDraftKind(mainView: string | undefined): DraftKind | null {
  if (mainView === "blog" || mainView === "blog-post") return "blog";
  return mainView && SITE_VIEWS.has(mainView) ? "site" : null;
}

/** The kind of draft a branch is: a Blog draft by its prefix, else the site's. */
export function branchDraftKind(branch: string | null | undefined): DraftKind {
  return isBlogDraftBranch(branch) ? "blog" : "site";
}

/**
 * The drafts a view lists: its own kind, plus the current one whatever its
 * kind (it is still where the user is). Anything counting or naming drafts
 * reads the whole list instead.
 */
export function draftsForView<T extends { branch: string }>(
  releases: readonly T[],
  kind: DraftKind,
  current: string | null | undefined,
): T[] {
  return releases.filter(
    (r) => branchDraftKind(r.branch) === kind || r.branch === current,
  );
}

/** The draft to move to when `deleted` (the current one) goes: another of the
 *  same kind, or `undefined`. */
export function siblingDraft<T extends { branch: string }>(
  releases: readonly T[],
  deleted: string,
  kind: DraftKind,
): T | undefined {
  return releases.find(
    (r) => r.branch !== deleted && branchDraftKind(r.branch) === kind,
  );
}

/** The default name of a draft on `branch`: "Blog Draft N" or "Draft N". */
export function draftNameKey(
  branch: string | null | undefined,
): TranslationKey {
  return isBlogDraftBranch(branch)
    ? "thread.branchPicker.blogDraftName"
    : "thread.branchPicker.defaultVersionName";
}

export type DraftThread = Pick<Task, "branch" | "metadata" | "partial">;

/**
 * Whether a view of `kind` can show `thread`. Blog takes its own drafts in
 * either runtime, and any sandbox: a branch adopted from Advanced opens one,
 * and it stays. What Blog refuses is a site draft in Fast Preview. The site
 * views refuse a Blog draft.
 */
export function viewAcceptsThread(
  kind: DraftKind | null,
  thread: DraftThread,
  project: VmcpRuntimeMetadata | null | undefined,
): boolean {
  if (kind === "blog") {
    return (
      isBlogDraftBranch(thread.branch) ||
      readThreadRuntime(thread.metadata, project) === "sandbox"
    );
  }
  if (kind === "site") return !isBlogDraftBranch(thread.branch);
  return true;
}

/**
 * Whether `thread` may be resumed as a view's entry (no thread in the URL): a
 * draft of the view's kind, in the project's runtime. Always a subset of
 * {@link viewAcceptsThread}, so an entry is never refused and sent to look for
 * an entry again.
 */
export function isEntryCandidate(
  kind: DraftKind | null,
  thread: DraftThread,
  project: VmcpRuntimeMetadata | null | undefined,
): boolean {
  return (
    !thread.partial &&
    (kind === "blog") === isBlogDraftBranch(thread.branch) &&
    threadRuntimeMatches(thread, defaultThreadRuntime(project))
  );
}

/**
 * What a thread created from Blog is: on the branch it was asked for (or
 * carried from the current one), else a fresh Blog draft. A Blog draft takes
 * the project's runtime; any other branch opens a sandbox, the only way Blog
 * shows one ({@link viewAcceptsThread}).
 */
export function blogThreadDefaults(
  branch: string | null | undefined,
  userLabel: string | null | undefined,
): { branch: string; runtime?: "sandbox" } {
  const next = branch || blogDraftBranchName(userLabel);
  return isBlogDraftBranch(next)
    ? { branch: next }
    : { branch: next, runtime: "sandbox" };
}

/**
 * The view to land on when switching to `thread` from a view of `kind`, or
 * `null` to stay: Blog can't show a site draft in Fast Preview, and the site
 * views can't show a Blog draft.
 */
export function viewForThreadSwitch(
  kind: DraftKind | null,
  thread: DraftThread,
  project: VmcpRuntimeMetadata | null | undefined,
): "site-editor" | "blog" | null {
  if (viewAcceptsThread(kind, thread, project)) return null;
  return kind === "blog" ? "site-editor" : "blog";
}

/** A fresh branch of the same kind as `branch`: a Blog draft stays Blog's. */
export function nextDraftBranch(
  branch: string | null | undefined,
  userLabel: string | null | undefined,
): string {
  return isBlogDraftBranch(branch)
    ? blogDraftBranchName(userLabel)
    : generateBranchName(userLabel);
}

/** Where a coding session goes after publishing its draft. */
export type DraftAfterPublish =
  | { kind: "repoint"; branch: string }
  | { kind: "new-thread"; runtime: ThreadRuntime; branch: string };

/**
 * A published draft is never edited again: the session moves to a fresh one,
 * a Blog draft from Blog (or from a Blog draft), else a site draft. A
 * CMS-default project goes back to a new Fast Preview thread; any other one
 * moves this thread to the fresh branch (a new sandbox, since pods are keyed
 * by branch).
 */
export function draftAfterPublish(input: {
  viewKind: DraftKind | null;
  branch: string | null | undefined;
  projectDefault: ThreadRuntime;
  userLabel: string | null | undefined;
}): DraftAfterPublish {
  const branch =
    input.viewKind === "blog" || isBlogDraftBranch(input.branch)
      ? blogDraftBranchName(input.userLabel)
      : generateBranchName(input.userLabel);
  return input.projectDefault === "cms"
    ? { kind: "new-thread", runtime: "cms", branch }
    : { kind: "repoint", branch };
}
