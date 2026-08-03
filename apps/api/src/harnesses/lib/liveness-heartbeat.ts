/**
 * Hosted liveness heartbeat scheduler.
 *
 * The hosted executor and parked-workflow monitor both need the same "call
 * `emit` after N ms of silence, reset the window on every real chunk, never
 * emit again after `stop()`" scheduler. It stays in the harness library so
 * both hosted call sites share one implementation without a dependency cycle.
 *
 * Pure: no NATS/DBOS/StudioContext/relay-transport knowledge — just a timer
 * plus the shared `data-liveness` wire-shape builder below. Uses
 * `@decocms/shared/std`'s `sleep(ms, { signal })` for the wait, never a hand-rolled
 * `setTimeout` loop (see the repo's async-primitives rule in
 * AGENTS.md/CLAUDE.md — `@decocms/shared/std` is the one canonical home for this).
 *
 * This module only emits heartbeats; it does not change the projector's
 * independent idle-window enforcement.
 */
import { sleep } from "@decocms/shared/std";

/**
 * Silence window before a heartbeat fires. MUST stay well under the
 * liveness enforcer's own idle window — `RUN_IDLE_TIMEOUT_MS` (10 minutes,
 * `apps/api/src/api/routes/decopilot/run-registry.ts`), which both the
 * projector's in-process consume-side timeout (`natsChunkSource`) and the
 * per-pod reaper backstop enforce. 30s gives ~20 heartbeats of margin inside
 * that 10-minute window, so a single dropped publish or a slow tick never
 * risks a false-positive liveness kill. Not imported from run-registry.ts on
 * purpose: the harness lib does not import the app tree (that would be
 * the wrong direction) — the relationship is documented here, not enforced
 * by import.
 */
export const LIVENESS_HEARTBEAT_INTERVAL_MS = 30_000;

/** Injectable wait primitive — defaults to `@decocms/shared/std`'s `sleep`. Tests
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
  /** Injected clock — see `HeartbeatSleepFn`. Defaults to `@decocms/shared/std`'s `sleep`. */
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

// --- Wire shape -------------------------------------------------------------

/**
 * Shape of the transient `data-liveness` chunk used by hosted execution.
 * Deliberately not typed against `ai`'s `UIMessageChunk`; the hosted wrapper
 * reasserts the stronger type at its boundary.
 */
export interface LivenessDataChunk {
  type: "data-liveness";
  data: { t: number };
  transient: true;
}

/** Builds one `data-liveness` chunk. `now` is injectable for tests. */
export function buildLivenessChunk(
  now: () => number = Date.now,
): LivenessDataChunk {
  return { type: "data-liveness", data: { t: now() }, transient: true };
}
