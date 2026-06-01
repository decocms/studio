// @decocms/std — small, zero-dependency, isomorphic standard utilities
// (Node / Bun / browser). The canonical home for ported std helpers so the
// same primitive isn't reinvented per app/package. See AGENTS.md.

export { delay, type DelayOptions } from "./delay";
export { retry, RetryError, type RetryOptions } from "./retry";
export { exponentialBackoffWithJitter } from "./backoff";

// `sleep` is the familiar name for a plain (optionally cancellable) wait — it's
// just `delay`. Prefer this over `Bun.sleep` (Bun-only) or a hand-rolled
// `new Promise(r => setTimeout(r, ms))`.
export { delay as sleep } from "./delay";
