import { describe, expect, test } from "bun:test";
import {
  buildLivenessChunk,
  HeartbeatEmitter,
  type HeartbeatSleepFn,
  LIVENESS_HEARTBEAT_INTERVAL_MS,
} from "./liveness-heartbeat";

// No real timers anywhere: tests inject a manually-driven sleepFn and elapse
// silence windows explicitly. Deterministic under any CI load (the previous
// small-real-interval style flaked on the loaded parallel runner), and every
// count asserts exactly instead of a jitter-tolerant lower bound.

function manualClock() {
  const pending: Array<() => void> = [];
  const sleepFn: HeartbeatSleepFn = (_ms, { signal }) =>
    new Promise<void>((resolve, reject) => {
      const entry = () => resolve();
      pending.push(entry);
      signal.addEventListener("abort", () => {
        const i = pending.indexOf(entry);
        if (i !== -1) pending.splice(i, 1);
        reject(signal.reason);
      });
    });
  return {
    sleepFn,
    /** Silence windows currently waiting to elapse (0 or 1 for one emitter). */
    pendingWindows: () => pending.length,
    /** Let the pending window elapse and drain the emit → re-arm chain. */
    async elapse() {
      pending.shift()?.();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
  };
}

describe("LIVENESS_HEARTBEAT_INTERVAL_MS", () => {
  test("is 30s, comfortably under the 10-minute liveness window", () => {
    expect(LIVENESS_HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(LIVENESS_HEARTBEAT_INTERVAL_MS).toBeLessThan(10 * 60 * 1000);
  });
});

describe("HeartbeatEmitter", () => {
  test("emits once per elapsed window while armed", async () => {
    const clock = manualClock();
    let emits = 0;
    const emitter = new HeartbeatEmitter({
      intervalMs: 25,
      sleepFn: clock.sleepFn,
      emit: () => {
        emits++;
      },
    });
    emitter.arm();
    await clock.elapse();
    await clock.elapse();
    await clock.elapse();
    emitter.stop();
    expect(emits).toBe(3);
  });

  test("a call to arm() before the window elapses resets it (disarmed on real chunk)", async () => {
    const clock = manualClock();
    let emits = 0;
    const emitter = new HeartbeatEmitter({
      intervalMs: 60,
      sleepFn: clock.sleepFn,
      emit: () => {
        emits++;
      },
    });
    emitter.arm();
    // 3 real chunks arrive — each re-arm cancels the pending window and
    // starts a fresh one, so exactly one window is ever pending.
    emitter.arm();
    emitter.arm();
    emitter.arm();
    expect(emits).toBe(0);
    expect(clock.pendingWindows()).toBe(1);
    // Now the window elapses with no further reset.
    await clock.elapse();
    emitter.stop();
    expect(emits).toBe(1);
  });

  test("never emits after stop()", async () => {
    const clock = manualClock();
    let emits = 0;
    const emitter = new HeartbeatEmitter({
      intervalMs: 10,
      sleepFn: clock.sleepFn,
      emit: () => {
        emits++;
      },
    });
    emitter.arm();
    emitter.stop();
    // stop() aborted the pending window — nothing left to elapse.
    expect(clock.pendingWindows()).toBe(0);
    await clock.elapse();
    expect(emits).toBe(0);
  });

  test("stop() during an in-flight window suppresses that pending emit", async () => {
    const clock = manualClock();
    let emits = 0;
    const emitter = new HeartbeatEmitter({
      intervalMs: 60,
      sleepFn: clock.sleepFn,
      emit: () => {
        emits++;
      },
    });
    emitter.arm();
    expect(clock.pendingWindows()).toBe(1);
    emitter.stop();
    expect(clock.pendingWindows()).toBe(0);
    await clock.elapse();
    expect(emits).toBe(0);
  });

  test("stop() is idempotent and arm() after stop() is a no-op", async () => {
    const clock = manualClock();
    let emits = 0;
    const emitter = new HeartbeatEmitter({
      intervalMs: 10,
      sleepFn: clock.sleepFn,
      emit: () => {
        emits++;
      },
    });
    emitter.stop();
    emitter.stop(); // idempotent — must not throw
    emitter.arm(); // stopped — must stay a no-op
    expect(clock.pendingWindows()).toBe(0);
    expect(emits).toBe(0);
  });

  test("self-reschedules: a long silence yields multiple heartbeats without re-arming", async () => {
    const clock = manualClock();
    let emits = 0;
    const emitter = new HeartbeatEmitter({
      intervalMs: 25,
      sleepFn: clock.sleepFn,
      emit: () => {
        emits++;
      },
    });
    emitter.arm();
    // No external arm() calls at all — each emit re-arms the next window.
    await clock.elapse();
    await clock.elapse();
    await clock.elapse();
    await clock.elapse();
    emitter.stop();
    expect(emits).toBe(4);
  });

  test("a rejecting emit stops the scheduler instead of looping forever", async () => {
    const clock = manualClock();
    let emits = 0;
    const emitter = new HeartbeatEmitter({
      intervalMs: 20,
      sleepFn: clock.sleepFn,
      emit: () => {
        emits++;
        throw new Error("publish failed");
      },
    });
    emitter.arm();
    await clock.elapse();
    // Exactly one emit: the throw stops the scheduler, so it never
    // rescheduled another window.
    expect(emits).toBe(1);
    expect(clock.pendingWindows()).toBe(0);
    await clock.elapse();
    expect(emits).toBe(1);
  });

  test("uses the default LIVENESS_HEARTBEAT_INTERVAL_MS when intervalMs is omitted", () => {
    let capturedMs: number | undefined;
    const emitter = new HeartbeatEmitter({
      emit: () => {},
      sleepFn: (ms, opts) => {
        capturedMs = ms;
        // Resolve only on abort so the test doesn't actually wait 30s.
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () =>
            reject(opts.signal.reason),
          );
        });
      },
    });
    emitter.arm();
    emitter.stop();
    expect(capturedMs).toBe(LIVENESS_HEARTBEAT_INTERVAL_MS);
  });
});

describe("buildLivenessChunk", () => {
  test("shape: data-liveness, transient, carries a timestamp — the single wire-format source of truth for T5 (hosted) and T6 (desktop daemon)", () => {
    const chunk = buildLivenessChunk(() => 12345);
    expect(chunk).toEqual({
      type: "data-liveness",
      data: { t: 12345 },
      transient: true,
    });
  });

  test("defaults `now` to Date.now", () => {
    const before = Date.now();
    const chunk = buildLivenessChunk();
    const after = Date.now();
    expect(chunk.data.t).toBeGreaterThanOrEqual(before);
    expect(chunk.data.t).toBeLessThanOrEqual(after);
  });
});
