/**
 * Pure status arithmetic for the decofile reads. Extracted so the two decisions
 * both Preview gates hang off are unit-testable without a stubbed `fetch`.
 */

/** What a `POST .../read` status says about the file, per the daemon contract. */
export type CommittedReadKind =
  /** Healthy daemon, file is not in the checkout (daemon answers 400). */
  | "absent"
  /** Sandbox not provisioned yet (404) — nothing proven either way. */
  | "unavailable"
  /** Body follows. */
  | "ok"
  /** Daemon reachable but broken — the caller throws and retries. */
  | "error";

export function classifyCommittedReadStatus(status: number): CommittedReadKind {
  if (status === 400) return "absent";
  if (status === 404) return "unavailable";
  return status >= 200 && status < 300 ? "ok" : "error";
}

/**
 * `.status` to tag on a failed decofile read, which
 * `resolveBlocksTabState` reads: 404 means "this repo does not use the deco
 * framework for sites" (a proof, and sticky per repo+branch), anything else
 * means "the read didn't resolve" (transient).
 *
 * Both proofs are equivalent, and neither needs a working dev server:
 * - `liveOk` — the dev server answered 200 with something that isn't a decofile
 *   (a plain Vite server hands back `index.html`), so it has no decofile route.
 * - `committedAbsent` — the checkout has neither `.deco/blocks.gen.json` nor a
 *   `.deco/blocks/` to regenerate it from. Block sources are committed files, so
 *   a deco site always has them once the clone lands; a repo without them has
 *   nothing a CMS could edit.
 *
 * The second is what makes the gate work with the dev server down or crashed —
 * the state where the live read can only ever yield a transient 502.
 */
export function decofileErrorStatus(input: {
  /** Live `/.decofile` answered 2xx (with a non-decofile body). */
  liveOk: boolean;
  /** Live `/.decofile` status, when it answered at all. */
  liveStatus?: number;
  committedAbsent: boolean;
}): number {
  if (input.liveOk || input.committedAbsent) return 404;
  return input.liveStatus ?? 502;
}
