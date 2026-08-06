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
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(text));
}
