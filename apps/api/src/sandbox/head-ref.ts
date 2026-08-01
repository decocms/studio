/**
 * Sticky HEAD ref for thread-scoped sandboxes.
 *
 * A thread's sandbox boots on a DERIVED ref (`thread:<id>/<conn>` →
 * `sandbox/thread-<id>-<conn>`, see `syntheticBranchToGitRef`). But whoever
 * works in the sandbox owns HEAD: the Super Agent is told to commit on a NEW
 * branch and open a PR (`enqueue-super-agent.ts`), so HEAD moves off the derived
 * ref and the daemon's shutdown push (`entry.ts`, HEAD-based) publishes the PR
 * branch instead. The derived ref therefore never lands on the remote, and the
 * next boot's `ls-remote` misses it and forks from the repo default — the
 * preview silently serves pre-change `main` while the work sits on the PR branch.
 *
 * Fix: remember the branch the sandbox was actually on (`metadata.headRef`) and
 * ask the daemon for THAT on the next boot. Recorded opportunistically whenever
 * Studio has a live daemon to ask (the events handler), read at provision time.
 *
 * Both decisions are pure functions so the rules are unit-testable without a
 * daemon: an inverted comparison here would either lose the PR branch or pin the
 * sandbox to a stale one.
 */

/** Daemon `/_sandbox/git/status` fields this module needs. */
export interface DaemonHeadStatus {
  /** Current branch name, or null when the daemon couldn't resolve one. */
  current?: string | null;
  /** True when HEAD is a bare commit — no branch to remember. */
  detached?: boolean;
  /** The repo's default branch, from `origin/HEAD`. */
  base?: string | null;
}

/**
 * Branches this must never remember, on top of the repo's own default (`base`).
 * A recorded ref is checked out on the next boot AND becomes the target of the
 * daemon's HEAD-based shutdown push — so remembering a shared branch would turn
 * an idle-evicted sandbox into a push to that branch. The whole point of the
 * derived `sandbox/thread-*` ref is that sandbox work never lands there.
 */
const NEVER_RECORD = new Set(["main", "master", "trunk", "develop", "HEAD"]);

/**
 * The daemon-reported HEAD worth persisting on the thread, or null.
 *
 * Records only a real branch that DIFFERS from the ref we asked the daemon to
 * check out. Skipping the equal case is what makes this idempotent AND
 * self-preserving: after a boot that failed to restore (tree forked onto the
 * derived ref), HEAD reads back as the derived ref, and recording that would
 * erase the memory of the PR branch and re-break the next boot.
 *
 * Consequence, accepted: a human who deliberately switches the sandbox BACK to
 * the derived ref keeps the older memory and boots onto the PR branch next time.
 * Preferring the branch that holds the work is the better failure direction.
 *
 * Refuses the repo default (`base`) and the {@link NEVER_RECORD} names outright:
 * a recorded ref is both checked out on the next boot AND the branch the
 * daemon's shutdown sync pushes, so remembering `main` would aim sandbox work at
 * `main`.
 */
export function pickRecordableHeadRef(args: {
  status: DaemonHeadStatus | null | undefined;
  /** The ref Studio asked the daemon to check out for this sandbox. */
  requestedRef: string | null;
}): string | null {
  // Destructured (not `status.current`) so the daemon's field name doesn't trip
  // the React `ban-ref-current-assignment` lint on a plain JSON payload.
  const { current: head, detached, base } = args.status ?? {};
  if (typeof head !== "string" || head.length === 0) return null;
  if (detached === true) return null;
  if (head === args.requestedRef) return null;
  if (NEVER_RECORD.has(head)) return null;
  if (typeof base === "string" && base.length > 0 && head === base) return null;
  return head;
}

/**
 * The ref Studio asks the daemon to check out.
 *
 * `recordedHeadRef` wins when sticky HEAD is enabled — that's the branch the
 * work is actually on. Everything else keeps today's behavior: the derived ref
 * for a synthetic thread key, the branch itself for a real one.
 */
export function pickGitBranch(args: {
  /** Isolation key: `thread:<id>[/<conn>]` (synthetic) or a real git ref. */
  branch: string;
  /** Derived ref for a synthetic key (`syntheticBranchToGitRef(branch)`). */
  derivedRef: string;
  /** `metadata.headRef` recorded from a live daemon, if any. */
  recordedHeadRef: string | null | undefined;
  /** Off → derived-ref behavior, unchanged. */
  sticky: boolean;
}): string {
  const isSynthetic = args.branch.startsWith("thread:");
  if (!isSynthetic) return args.branch;
  if (args.sticky && args.recordedHeadRef) return args.recordedHeadRef;
  return args.derivedRef;
}
