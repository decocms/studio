/**
 * Daemon ⇄ harness-runner wire protocol (internal, loopback-only).
 *
 * The daemon spawns the runner (its own bundle with HARNESS_RUNNER_MODE=1),
 * reads the ready line from the runner's stdout to learn the ephemeral port,
 * then POSTs `{harnessId, input}` to `/run` with the per-spawn bearer token.
 * The runner answers 200 `application/x-ndjson`: one `DispatchSSEEvent` JSON
 * per line, always terminated by `{"type":"done"}`. Cancellation is the
 * daemon aborting the /run request. This file must stay free of harness
 * imports — it is the piece a non-TS daemon reimplements.
 */

export const HARNESS_RUNNER_MODE_ENV = "HARNESS_RUNNER_MODE";
export const HARNESS_RUNNER_TOKEN_ENV = "HARNESS_RUNNER_TOKEN";
export const HARNESS_RUNNER_CMD_ENV = "HARNESS_RUNNER_CMD";
export const HARNESS_RUNNER_READY_PREFIX = "HARNESS_RUNNER_READY ";

/** Harness ids the daemon accepts on /dispatch. Duplicated from the factory
 *  ids registered in serve.ts so the daemon side never imports harness code;
 *  dispatch-registry.test.ts locks the two lists together. */
export const DISPATCHABLE_HARNESS_IDS = ["claude-code", "codex"] as const;
