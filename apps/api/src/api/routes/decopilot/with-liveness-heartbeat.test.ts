import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import type { HeartbeatSleepFn } from "@decocms/harness/liveness-heartbeat";
import {
  buildLivenessChunk,
  withLivenessHeartbeat,
} from "./with-liveness-heartbeat";

// No real timers anywhere: silence is a manually-elapsed clock window and
// source pacing is a test-resolved gate. Deterministic under any CI load
// (the previous small-real-interval style flaked on the loaded parallel
// runner), and heartbeat counts assert exactly.

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
    pendingWindows: () => pending.length,
    /** Wait (microtasks only) for the emitter to arm, then elapse a window
     *  and drain the emit → race → yield → for-await → re-arm chain. The
     *  drain count is generous because the chain crosses an async generator
     *  and its consumer (~10 microtasks) — but it's still load-independent:
     *  microtask scheduling doesn't stretch under CPU contention the way
     *  real timers do, which is the whole point of this style. */
    async elapse() {
      for (let i = 0; i < 50 && pending.length === 0; i++) {
        await Promise.resolve();
      }
      pending.shift()?.();
      await this.drain();
    },
    /** Let the source's immediate chunks flow through (microtasks only) so
     *  the silence window being elapsed is the one armed AFTER the last real
     *  chunk — an emit racing an already-arrived chunk loses and is dropped
     *  by design (the wrapper re-arms on real chunks). */
    async drain() {
      for (let i = 0; i < 32; i++) await Promise.resolve();
    },
  };
}

/** A promise the test resolves to let a gated source proceed. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

async function collect(
  iter: AsyncGenerator<UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  for await (const chunk of iter) out.push(chunk);
  return out;
}

describe("buildLivenessChunk", () => {
  test("shape: data-liveness, transient, carries a timestamp", () => {
    const chunk = buildLivenessChunk(() => 12345);
    expect(chunk).toEqual({
      type: "data-liveness",
      data: { t: 12345 },
      transient: true,
    });
  });
});

describe("withLivenessHeartbeat", () => {
  test("no heartbeats when the source never goes silent", async () => {
    const clock = manualClock();
    async function* fast(): AsyncGenerator<UIMessageChunk> {
      yield { type: "text-start", id: "1" };
      yield { type: "text-delta", id: "1", delta: "hi" };
    }
    const out = await collect(
      withLivenessHeartbeat(fast(), { intervalMs: 30, sleepFn: clock.sleepFn }),
    );
    expect(out.map((c) => c.type)).toEqual(["text-start", "text-delta"]);
  });

  test("injects a data-liveness chunk after a window of silence, then resumes the source", async () => {
    const clock = manualClock();
    const silence = gate();
    async function* slowThenFast(): AsyncGenerator<UIMessageChunk> {
      yield { type: "text-start", id: "1" };
      await silence.opened;
      yield { type: "text-delta", id: "1", delta: "done waiting" };
    }
    const collecting = collect(
      withLivenessHeartbeat(slowThenFast(), {
        intervalMs: 25,
        sleepFn: clock.sleepFn,
      }),
    );
    await clock.drain(); // text-start flows; silence begins
    await clock.elapse(); // first silence window → heartbeat
    await clock.elapse(); // still silent → second heartbeat
    silence.open();
    const out = await collecting;
    expect(out.map((c) => c.type)).toEqual([
      "text-start",
      "data-liveness",
      "data-liveness",
      "text-delta",
    ]);
  });

  test("a real chunk resets the window (disarmed) — no heartbeat while chunks keep arriving", async () => {
    const clock = manualClock();
    async function* steadyDrip(): AsyncGenerator<UIMessageChunk> {
      for (let i = 0; i < 4; i++) {
        yield { type: "text-delta", id: "1", delta: String(i) };
      }
    }
    const out = await collect(
      withLivenessHeartbeat(steadyDrip(), {
        intervalMs: 60,
        sleepFn: clock.sleepFn,
      }),
    );
    // The window never elapsed (the test never let it), so pure pass-through.
    expect(out.every((c) => c.type === "text-delta")).toBe(true);
    expect(out).toHaveLength(4);
  });

  test("stops cleanly on source completion — no dangling window after the stream ends", async () => {
    const clock = manualClock();
    async function* short(): AsyncGenerator<UIMessageChunk> {
      yield { type: "text-start", id: "1" };
    }
    const out = await collect(
      withLivenessHeartbeat(short(), {
        intervalMs: 10,
        sleepFn: clock.sleepFn,
      }),
    );
    expect(out).toEqual([{ type: "text-start", id: "1" }]);
    // Stronger than waiting for a misfire: the emitter was stopped, so no
    // silence window is left pending at all.
    expect(clock.pendingWindows()).toBe(0);
  });

  test("propagates a source error and stops emitting heartbeats", async () => {
    const clock = manualClock();
    async function* boom(): AsyncGenerator<UIMessageChunk> {
      yield { type: "text-start", id: "1" };
      throw new Error("harness exploded");
    }
    let caught: unknown;
    const out: UIMessageChunk[] = [];
    try {
      for await (const chunk of withLivenessHeartbeat(boom(), {
        intervalMs: 10,
        sleepFn: clock.sleepFn,
      })) {
        out.push(chunk);
      }
    } catch (err) {
      caught = err;
    }
    expect(out).toEqual([{ type: "text-start", id: "1" }]);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("harness exploded");
    expect(clock.pendingWindows()).toBe(0);
  });

  test("an early consumer break stops the underlying source and the heartbeat window", async () => {
    const clock = manualClock();
    let sourceCleanedUp = false;
    async function* infinite(): AsyncGenerator<UIMessageChunk> {
      try {
        let i = 0;
        while (true) {
          yield { type: "text-delta", id: "1", delta: String(i++) };
        }
      } finally {
        sourceCleanedUp = true;
      }
    }
    let count = 0;
    for await (const _chunk of withLivenessHeartbeat(infinite(), {
      intervalMs: 10,
      sleepFn: clock.sleepFn,
    })) {
      count++;
      if (count === 2) break;
    }
    expect(count).toBe(2);
    expect(sourceCleanedUp).toBe(true);
    expect(clock.pendingWindows()).toBe(0);
  });

  test("a long silence yields multiple heartbeats, not just one", async () => {
    const clock = manualClock();
    const silence = gate();
    async function* longSilence(): AsyncGenerator<UIMessageChunk> {
      await silence.opened;
      yield { type: "finish" };
    }
    const collecting = collect(
      withLivenessHeartbeat(longSilence(), {
        intervalMs: 25,
        sleepFn: clock.sleepFn,
      }),
    );
    await clock.elapse();
    await clock.elapse();
    await clock.elapse();
    await clock.elapse();
    silence.open();
    const out = await collecting;
    expect(out.filter((c) => c.type === "data-liveness")).toHaveLength(4);
    expect(out.at(-1)?.type).toBe("finish");
  });
});
