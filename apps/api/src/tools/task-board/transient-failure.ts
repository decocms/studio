/**
 * Was a run's failure the infrastructure's fault?
 *
 * The distinction decides what happens to the card: an infrastructure failure
 * is worth re-dispatching unchanged (the task never got a chance to run), while
 * a failure the agent itself produced will reproduce on a retry and belongs back
 * in To Do where a human sees it.
 *
 * The signal we get is `threads.failure_kind` plus, for the generic `"error"`
 * kind, the text of the run's error part. Some kinds are infrastructure by
 * construction: `stall` (the idle reaper found no progress), `liveness` and
 * `projection` (the run's stream died under the projector), `abandoned` (a run
 * that never started at all). `cancelled` and `superseded` are deliberate human
 * acts and are never retried.
 *
 * ponytail: `"error"` is classified by matching the error text against a short
 * list of infrastructure messages, because that kind is written by
 * `run-reactor` for ANY harness error — the sandbox-provisioning timeout and a
 * bug in the agent's own code arrive identically. The upgrade path is a typed
 * failure kind at the throw site (`SandboxTimeoutError` in
 * `packages/sandbox/.../client.ts` already exists as a class; it just doesn't
 * survive the trip through the error part), at which point this list goes away.
 * Keep the list SHORT and specific: a false positive burns a retry, and every
 * entry must be a message a healthy cluster does not produce.
 */

import { SANDBOX_UNREACHABLE_PREFIX } from "@decocms/sandbox/dispatch/error-codes";

/** Failure kinds that are infrastructure whatever the message says. */
const TRANSIENT_KINDS = new Set([
  "stall",
  "liveness",
  "projection",
  "abandoned",
]);

/** Failure kinds a human caused on purpose — never retried. */
const DELIBERATE_KINDS = new Set(["cancelled", "superseded"]);

/**
 * Infrastructure messages behind the generic `"error"` kind. Anchored to the
 * distinctive part of each message, not to a wording we'd have to keep in sync.
 */
const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  // Sandbox never reached Ready — the pool or the node had no room. This is the
  // one that stranded eight cards at once.
  /sandbox did not become ready/i,
  // Provider/daemon unreachable while claiming or dispatching.
  /sandbox (?:provisioning|claim) failed/i,
  // The pod's preflight found Studio's own MCP unreachable and refused to run
  // ("studio MCP is unusable (...): studio=failed"). Nothing about the task —
  // Studio was saturated, restarting, or out of DB connections. Observed on a
  // second 8-card burst, where it took 4 of the 8.
  /mcp is unusable/i,
  // The daemon's stream died mid-run. The work may be half-done, which is why
  // the re-dispatch reuses the PR branch when there is one.
  /harness_crashed: unexpected eof/i,
  // Postgres connection exhaustion under a burst: "sorry, too many clients
  // already" from the server, or pg-pool giving up waiting for one of its own
  // (`connectionTimeoutMillis`) — "timeout exceeded when trying to connect".
  // Both took runs (and reviewer runs) in the same burst.
  /too many clients already|timeout exceeded when trying to connect/i,
  // Upstream rate limit / capacity, from the model gateway or GitHub.
  /\b(?:429|503)\b|too many requests|service unavailable/i,
];

/**
 * How many times a card may be re-dispatched after this failure.
 *
 * The policy is "always recover from infrastructure, and give everything else
 * exactly one benefit of the doubt":
 *
 * - **Recognized infrastructure** gets the full budget. These reproduce until
 *   capacity returns, and waiting is the whole fix.
 * - **Anything unrecognized** gets ONE retry. The generic `"error"` kind covers
 *   both a real agent error and an infrastructure failure whose message we've
 *   never seen — and the second kind keeps showing up (three new messages in two
 *   bursts). Parking those was how a card silently stopped moving, and one extra
 *   run is cheaper than a human noticing. A genuine agent error simply
 *   reproduces and lands in To Do one attempt later.
 * - **Deliberate** acts get none: a human cancelled it.
 *
 * Budgets, not booleans, so a broken cluster still terminates.
 */
export const TRANSIENT_RETRY_BUDGET = 3;
export const UNKNOWN_RETRY_BUDGET = 1;

export function retryBudgetFor(failure: {
  kind: string | null;
  errorText?: string | null;
}): number {
  if (DELIBERATE_KINDS.has(failure.kind ?? "")) return 0;
  return isTransientRunFailure(failure)
    ? TRANSIENT_RETRY_BUDGET
    : UNKNOWN_RETRY_BUDGET;
}

export function isTransientRunFailure(failure: {
  kind: string | null;
  /** The run's error part text, when it has one. */
  errorText?: string | null;
}): boolean {
  const kind = failure.kind ?? "";
  if (DELIBERATE_KINDS.has(kind)) return false;
  if (TRANSIENT_KINDS.has(kind)) return true;
  const text = failure.errorText ?? "";
  if (!text) return false;
  // Every `SandboxUnreachableError` — the pod stopped mid-turn, its stream
  // broke, it went silent, or it reported `sandbox_gone`. Checked by MARKER
  // rather than by wording: the class's constructor stamps it, so unlike the
  // patterns below this cannot drift and a new throw site is covered the day it
  // is written. This is the most common infrastructure failure the board sees
  // and it matched none of the patterns, so every one of them got the
  // unknown-error budget of a single attempt.
  if (text.includes(SANDBOX_UNREACHABLE_PREFIX)) return true;
  // A `429`/`503` inside a URL path (`…/pulls/429/files`) is a PR number, not a status.
  const withoutUrls = text.replace(/https?:\/\/\S+/gi, " ");
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(withoutUrls));
}
