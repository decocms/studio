/** Terminal error codes carried in link `{type:"error", code}` frames /
 *  dispatch SSE error events. A thin shared vocabulary — each transport maps
 *  INTO these where meaningful. NOT a unified cancel model. */
export const LINK_ERROR_CODES = [
  "publish_failed",
  "ws_closed",
  "harness_crashed",
  "bad_input",
  "unknown_harness",
  "tombstoned",
  "offload_fetch_failed",
] as const;

export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number];

/**
 * The daemon's terminal code for a run its pod could not finish: the daemon is
 * shutting down (SIGTERM → `CancelAll`, i.e. the pod was evicted or scaled in)
 * or the client's connection dropped. NOT `cancelled` — nobody asked for this
 * to stop, the work is in the checkout (and, on shutdown, pushed to the branch
 * by the publish that runs right after), and the turn is continuable on a
 * replacement pod.
 *
 * Kept here rather than next to the daemon because both ends must agree on the
 * literal: the daemon writes it, `sandbox-dispatch-client` maps it to
 * `SandboxUnreachableError`.
 */
export const SANDBOX_GONE_TERMINAL_CODE = "sandbox_gone";

/**
 * Stable marker on every `SandboxUnreachableError` message — same convention as
 * `[SUBSCRIPTION_REQUIRED]` and `[CREDITS]`: a prefix that survives the trip
 * through an error part's text, so a reader downstream can recognize the class
 * without matching prose.
 *
 * The reader is `isTransientRunFailure` (tools/task-board/transient-failure.ts),
 * which decides whether a failed task run is worth re-dispatching. It used to
 * match each of these messages by wording and matched none of them, so the most
 * common infrastructure failure there is got the unknown-error budget of one
 * attempt instead of the full three.
 */
export const SANDBOX_UNREACHABLE_PREFIX = "[SANDBOX_UNREACHABLE]";
