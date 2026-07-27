import { describe, expect, test } from "bun:test";
import { sleep } from "@decocms/shared/std";
import {
  buildLivenessChunk,
  HeartbeatEmitter,
  LIVENESS_HEARTBEAT_INTERVAL_MS,
} from "./liveness-heartbeat";

// Small real intervals (matches this repo's established idle-timeout test
// style — see nats-chunk-source.test.ts — rather than mocking the clock).
// Margins are deliberately generous (intervals in the tens of ms, assertions
// mostly one-sided lower bounds): under a full parallel `bun test` run
// (hundreds of files/timers contending for the event loop) a tight window
// with a tight bound flakes on scheduler jitter alone, not a real bug — this
// bit us once during development with a 10ms interval / exact-count bound.

describe("LIVENESS_HEARTBEAT_INTERVAL_MS", () => {
  test("is 30s, comfortably under the 10-minute liveness window", () => {
    expect(LIVENESS_HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(LIVENESS_HEARTBEAT_INTERVAL_MS).toBeLessThan(10 * 60 * 1000);
  });
});

describe("HeartbeatEmitter", () => {
  test("emits every intervalMs while armed", async () => {
    let emits = 0;
    const emitter = new HeartbeatEmitter({
      intervalMs: 25,
      emit: () => {
        emits++;
      },
    });
    emitter.arm();
    // ~5.8 windows of headroom for 3 emits: setTimeout chains drift hard on a
    // loaded 4-vCPU CI runner (parallel bun test workers), and 3.8 windows
    // already flaked there once.
    await sleep(25 * 5 + 20);
    emitter.stop();
    expect(emits).toBeGreaterThanOrEqual(3);
  });

  test("a call to arm() before the window elapses resets it (disarmed on real chunk)", async () => {
    let emits = 0;
    const emitter = new HeartbeatEmitter({
      intervalMs: 60,
      emit: () => {
        emits++;
      },
    });
    emitter.arm();
    // Simulate 3 real chunks arriving well inside the window (7.5x margin)
    // — each resets the silence clock, so the window never actually elapses.
    await sleep(8);
    emitter.arm();
    await sleep(8);
    emitter.arm();
    await sleep(8);
    emitter.arm();
    expect(emits).toBe(0);
    // Now let a full window elapse with no further reset.
    await sleep(80);
    emitter.stop();
    expect(emits).toBe(1);
  });

  test("never emits after stop()", async () => {
    let emits = 0;
    const emitter = new HeartbeatEmitter({
      intervalMs: 10,
      emit: () => {
        emits++;
      },
    });
    emitter.arm();
    emitter.stop();
    await sleep(40);
    expect(emits).toBe(0);
  });

  test("stop() during an in-flight window suppresses that pending emit", async () => {
    let emits = 0;
    const emitter = new HeartbeatEmitter({
      intervalMs: 60,
      emit: () => {
        emits++;
      },
    });
    emitter.arm();
    await sleep(5); // well inside the window (12x margin)
    emitter.stop();
    await sleep(80); // past when the (now-cancelled) window would have fired
    expect(emits).toBe(0);
  });

  test("stop() is idempotent and arm() after stop() is a no-op", async () => {
    let emits = 0;
    const emitter = new HeartbeatEmitter({
      intervalMs: 10,
      emit: () => {
        emits++;
      },
    });
    emitter.stop();
    emitter.stop(); // idempotent — must not throw
    emitter.arm(); // stopped — must stay a no-op
    await sleep(30);
    expect(emits).toBe(0);
  });

  test("self-reschedules: a long silence yields multiple heartbeats without re-arming", async () => {
    let emits = 0;
    const emitter = new HeartbeatEmitter({
      intervalMs: 25,
      emit: () => {
        emits++;
      },
    });
    emitter.arm();
    await sleep(25 * 5 + 20); // ~5.8 windows, no external arm() calls at all
    emitter.stop();
    expect(emits).toBeGreaterThanOrEqual(4);
  });

  test("a rejecting emit stops the scheduler instead of looping forever", async () => {
    let emits = 0;
    const emitter = new HeartbeatEmitter({
      intervalMs: 20,
      emit: () => {
        emits++;
        throw new Error("publish failed");
      },
    });
    emitter.arm();
    await sleep(20 * 4);
    // Exactly one emit: the throw stops the scheduler, so it never reschedules.
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
