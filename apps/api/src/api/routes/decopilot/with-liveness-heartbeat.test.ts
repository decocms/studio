import { describe, expect, test } from "bun:test";
import { sleep } from "@decocms/shared/std";
// Margins are deliberately generous (intervals in the tens of ms, mostly
// one-sided lower-bound assertions): under a full parallel `bun test` run a
// tight window + tight bound flakes on scheduler jitter alone, not a real
// bug — this bit us once during development with a 10ms interval.
import type { UIMessageChunk } from "ai";
import {
  buildLivenessChunk,
  withLivenessHeartbeat,
} from "./with-liveness-heartbeat";

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
  test("no heartbeats when the source is faster than the interval", async () => {
    async function* fast(): AsyncGenerator<UIMessageChunk> {
      yield { type: "text-start", id: "1" };
      await sleep(5);
      yield { type: "text-delta", id: "1", delta: "hi" };
    }
    const out = await collect(
      withLivenessHeartbeat(fast(), { intervalMs: 30 }),
    );
    expect(out.map((c) => c.type)).toEqual(["text-start", "text-delta"]);
  });

  test("injects a data-liveness chunk after intervalMs of silence, then resumes the source", async () => {
    async function* slowThenFast(): AsyncGenerator<UIMessageChunk> {
      yield { type: "text-start", id: "1" };
      // ~6 heartbeat windows at intervalMs=25 for a >=2 assertion — smaller
      // margins flake under CI CPU contention (parallel unit suite).
      await sleep(150);
      yield { type: "text-delta", id: "1", delta: "done waiting" };
    }
    const out = await collect(
      withLivenessHeartbeat(slowThenFast(), { intervalMs: 25 }),
    );
    const types = out.map((c) => c.type);
    expect(types[0]).toBe("text-start");
    expect(types.at(-1)).toBe("text-delta");
    const heartbeats = types.filter((t) => t === "data-liveness");
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    // Every heartbeat is between the two real chunks, not before/after.
    expect(types.slice(1, -1).every((t) => t === "data-liveness")).toBe(true);
  });

  test("a real chunk resets the window (disarmed) — no heartbeat right after one arrives", async () => {
    async function* steadyDrip(): AsyncGenerator<UIMessageChunk> {
      // 4 chunks, each 8ms apart, well under the 60ms interval (7.5x
      // margin) — the window should never elapse because every chunk
      // re-arms it.
      for (let i = 0; i < 4; i++) {
        await sleep(8);
        yield { type: "text-delta", id: "1", delta: String(i) };
      }
    }
    const out = await collect(
      withLivenessHeartbeat(steadyDrip(), { intervalMs: 60 }),
    );
    expect(out.every((c) => c.type === "text-delta")).toBe(true);
    expect(out).toHaveLength(4);
  });

  test("stops cleanly on source completion — never emits after the stream ends", async () => {
    async function* short(): AsyncGenerator<UIMessageChunk> {
      yield { type: "text-start", id: "1" };
    }
    const out = await collect(
      withLivenessHeartbeat(short(), { intervalMs: 10 }),
    );
    expect(out).toEqual([{ type: "text-start", id: "1" }]);
    // Give a would-be dangling timer a chance to misfire; collect() already
    // awaited the generator to natural completion, so nothing further can
    // be yielded regardless — this just documents the intent.
    await sleep(30);
  });

  test("propagates a source error and stops emitting heartbeats", async () => {
    async function* boom(): AsyncGenerator<UIMessageChunk> {
      yield { type: "text-start", id: "1" };
      await sleep(5);
      throw new Error("harness exploded");
    }
    let caught: unknown;
    const out: UIMessageChunk[] = [];
    try {
      for await (const chunk of withLivenessHeartbeat(boom(), {
        intervalMs: 10,
      })) {
        out.push(chunk);
      }
    } catch (err) {
      caught = err;
    }
    expect(out).toEqual([{ type: "text-start", id: "1" }]);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("harness exploded");
  });

  test("an early consumer break stops the underlying source and the heartbeat timer", async () => {
    let sourceCleanedUp = false;
    async function* infinite(): AsyncGenerator<UIMessageChunk> {
      try {
        let i = 0;
        while (true) {
          await sleep(5);
          yield { type: "text-delta", id: "1", delta: String(i++) };
        }
      } finally {
        sourceCleanedUp = true;
      }
    }
    let count = 0;
    for await (const _chunk of withLivenessHeartbeat(infinite(), {
      intervalMs: 10,
    })) {
      count++;
      if (count === 2) break;
    }
    expect(count).toBe(2);
    expect(sourceCleanedUp).toBe(true);
  });

  test("a long silence yields multiple heartbeats, not just one", async () => {
    async function* longSilence(): AsyncGenerator<UIMessageChunk> {
      await sleep(145); // ~5.8 windows at intervalMs=25
      yield { type: "finish" };
    }
    const out = await collect(
      withLivenessHeartbeat(longSilence(), { intervalMs: 25 }),
    );
    const heartbeats = out.filter((c) => c.type === "data-liveness");
    expect(heartbeats.length).toBeGreaterThanOrEqual(4);
    expect(out.at(-1)?.type).toBe("finish");
  });
});
