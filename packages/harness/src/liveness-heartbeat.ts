/**
 * Liveness heartbeat scheduler (unified-control-plane T5/T6).
 *
 * Shared between the hosted executor (apps/mesh's decopilot dispatch, T5)
 * and the desktop daemon's relay pump (packages/sandbox, T6) — both need the
 * exact same "call `emit` after N ms of silence, reset the window on every
 * real chunk, never emit again after `stop()`" scheduler; only the wiring
 * (what `emit` actually publishes) differs per executor. Lives here because
 * both `apps/mesh` and `packages/sandbox` already depend on `@decocms/harness`
 * (see `packages/sandbox/package.json`), so this is reachable from both
 * without a reverse dependency.
 *
 * Pure: no NATS/DBOS/StudioContext/relay-transport knowledge — just a timer.
 * Uses `@decocms/std`'s `sleep(ms, { signal })` for the wait, never a
 * hand-rolled `setTimeout` loop (see the repo's async-primitives rule in
 * AGENTS.md/CLAUDE.md — `@decocms/std` is the one canonical home for this).
 */
import { sleep } from "@decocms/std";

/**
 * Silence window before a heartbeat fires. MUST stay well under the
 * liveness enforcer's own idle window — `RUN_IDLE_TIMEOUT_MS` (10 minutes,
 * `apps/mesh/src/api/routes/decopilot/run-registry.ts`), which both the
 * projector's in-process consume-side timeout (`natsChunkSource`) and the
 * per-pod reaper backstop enforce. 30s gives ~20 heartbeats of margin inside
 * that 10-minute window, so a single dropped publish or a slow tick never
 * risks a false-positive liveness kill. Not imported from run-registry.ts on
 * purpose: `packages/harness` has no dependency on `apps/mesh` (that would be
 * the wrong direction) — the relationship is documented here, not enforced
 * by import.
 */
export const LIVENESS_HEARTBEAT_INTERVAL_MS = 30_000;

/** Injectable wait primitive — defaults to `@decocms/std`'s `sleep`. Tests
 *  inject a small `intervalMs` (matching this repo's existing idle-timeout
 *  test style, e.g. `nats-chunk-source.test.ts`) rather than mocking this. */
export type HeartbeatSleepFn = (
  ms: number,
  opts: { signal: AbortSignal },
) => Promise<void>;

export interface HeartbeatEmitterOptions {
  /** Called each time the silence window elapses without a reset. May be
   *  async; a throw/rejection stops the scheduler (treated like `stop()`)
   *  rather than looping forever on a broken emit (e.g. a publish failure). */
  emit: () => void | Promise<void>;
  /** Silence window before firing. Defaults to `LIVENESS_HEARTBEAT_INTERVAL_MS`. */
  intervalMs?: number;
  /** Injected clock — see `HeartbeatSleepFn`. Defaults to `@decocms/std`'s `sleep`. */
  sleepFn?: HeartbeatSleepFn;
}

/**
 * Pure timer scheduler: emits on a fixed interval while ARMED, resets on
 * every call to `arm()` (a real chunk/relay line arrived), and never emits
 * again once `stop()`ped.
 *
 * Usage: call `arm()` once to start watching for silence, then call `arm()`
 * again on every real chunk (this cancels the pending heartbeat and starts a
 * fresh window — it does NOT disable the scheduler, just resets it). The
 * scheduler self-reschedules after every successful emit, so multiple
 * heartbeats fire during one long silent gap (a 5-minute tool call yields
 * ~10 heartbeats at the default interval). Call `stop()` once the underlying
 * stream ends or errors — idempotent, safe to call multiple times.
 */
export class HeartbeatEmitter {
  private readonly intervalMs: number;
  private readonly emitFn: () => void | Promise<void>;
  private readonly sleepFn: HeartbeatSleepFn;
  private controller: AbortController | null = null;
  private stopped = false;

  constructor(options: HeartbeatEmitterOptions) {
    this.intervalMs = options.intervalMs ?? LIVENESS_HEARTBEAT_INTERVAL_MS;
    this.emitFn = options.emit;
    this.sleepFn = options.sleepFn ?? sleep;
  }

  /**
   * (Re)start the silence window from now. Idempotent-safe to call
   * repeatedly (e.g. once per real chunk) — each call cancels the
   * previously-pending wait (via its `AbortSignal`) and starts a fresh one.
   * No-op once `stop()`ped.
   */
  arm(): void {
    if (this.stopped) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    void this.wait(controller.signal);
  }

  private async wait(signal: AbortSignal): Promise<void> {
    try {
      await this.sleepFn(this.intervalMs, { signal });
    } catch {
      // Aborted by a re-arm (real chunk arrived) or by stop() — not a real
      // timeout. Swallow: the caller either already started a fresh window
      // (re-arm) or wants no more emits (stop).
      return;
    }
    if (this.stopped || signal.aborted) return;
    try {
      await this.emitFn();
    } catch {
      // A broken emit (e.g. the publish call itself failed) must not spin
      // the scheduler forever on a stream that can no longer make progress
      // anyway — stop like the underlying stream errored.
      this.stop();
      return;
    }
    // Self-reschedule: one heartbeat fired, arm the next window unless
    // something stopped us (or re-armed us — a real chunk racing the emit)
    // while `emitFn` was in flight.
    if (!this.stopped && !signal.aborted) this.arm();
  }

  /** Permanently stop. No further emits, even if a wait is in flight. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller?.abort();
    this.controller = null;
  }
}
