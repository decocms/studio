import { describe, it, expect } from "bun:test";
import { ProgressBumpThrottle, tapProgressStream } from "./progress-bump";

describe("ProgressBumpThrottle", () => {
  it("allows the first bump, then throttles within the interval", () => {
    const t = new ProgressBumpThrottle(3_000);
    expect(t.shouldBump("task1", 0)).toBe(true);
    expect(t.shouldBump("task1", 100)).toBe(false);
    expect(t.shouldBump("task1", 2_999)).toBe(false);
  });

  it("allows another bump once the interval has elapsed", () => {
    const t = new ProgressBumpThrottle(3_000);
    expect(t.shouldBump("task1", 0)).toBe(true);
    expect(t.shouldBump("task1", 3_000)).toBe(true);
    // resets the window from the last accepted bump
    expect(t.shouldBump("task1", 4_000)).toBe(false);
    expect(t.shouldBump("task1", 6_000)).toBe(true);
  });

  it("is independent per task", () => {
    const t = new ProgressBumpThrottle(3_000);
    expect(t.shouldBump("a", 0)).toBe(true);
    expect(t.shouldBump("b", 0)).toBe(true);
    expect(t.shouldBump("a", 100)).toBe(false);
    expect(t.shouldBump("b", 100)).toBe(false);
  });

  it("clear() forgets a task so the next bump is allowed immediately", () => {
    const t = new ProgressBumpThrottle(3_000);
    expect(t.shouldBump("task1", 0)).toBe(true);
    expect(t.shouldBump("task1", 100)).toBe(false);
    t.clear("task1");
    expect(t.shouldBump("task1", 200)).toBe(true);
  });

  it("boundary: exactly at the interval is allowed", () => {
    const t = new ProgressBumpThrottle(3_000);
    expect(t.shouldBump("task1", 1_000)).toBe(true);
    // now - last === interval → not < interval → allowed
    expect(t.shouldBump("task1", 4_000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tapProgressStream — the run liveness heartbeat tap (sole heartbeat for
// both hosted and desktop runs). `chunkStream` in project-chunks.ts is a
// `ReadableStream<UIMessageChunk>` (not an AsyncIterable), so the tap is a
// pass-through TransformStream.
// ---------------------------------------------------------------------------

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value as T);
  }
  return out;
}

function streamFrom<T>(items: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const item of items) controller.enqueue(item);
      controller.close();
    },
  });
}

describe("tapProgressStream", () => {
  it("yields every chunk unchanged, in order", async () => {
    const throttle = new ProgressBumpThrottle(3_000);
    const tapped = tapProgressStream(
      streamFrom([1, 2, 3, 4]),
      "task1",
      throttle,
      () => {},
    );
    expect(await collect(tapped)).toEqual([1, 2, 3, 4]);
  });

  it("calls onBump once per throttle window across many items", async () => {
    // Window far longer than the test's own runtime, so every item after the
    // first is deterministically inside the same window.
    const throttle = new ProgressBumpThrottle(60_000);
    let bumps = 0;
    const out = await collect(
      tapProgressStream(
        streamFrom(["a", "b", "c", "d", "e"]),
        "task1",
        throttle,
        () => {
          bumps += 1;
        },
      ),
    );
    expect(out).toEqual(["a", "b", "c", "d", "e"]);
    expect(bumps).toBe(1);
  });

  it("does not call onBump when the throttle denies (window not elapsed)", async () => {
    const throttle = new ProgressBumpThrottle(60_000);
    throttle.shouldBump("task1"); // consumes the window (real Date.now())
    let bumps = 0;
    await collect(
      tapProgressStream(streamFrom([1]), "task1", throttle, () => {
        bumps += 1;
      }),
    );
    expect(bumps).toBe(0);
  });

  it("forgets throttle state once the stream completes", async () => {
    const throttle = new ProgressBumpThrottle(60_000);
    await collect(
      tapProgressStream(streamFrom([1]), "task1", throttle, () => {}),
    );
    // State was cleared on completion, so the next bump for the SAME task is
    // allowed immediately — even though the 60s window hasn't elapsed.
    expect(throttle.shouldBump("task1")).toBe(true);
  });

  it("is independent per task — a busy task's window doesn't block another task's first bump", async () => {
    const throttle = new ProgressBumpThrottle(60_000);
    throttle.shouldBump("task1"); // task1 now inside its window
    let bumps = 0;
    await collect(
      tapProgressStream(streamFrom([1]), "task2", throttle, () => {
        bumps += 1;
      }),
    );
    expect(bumps).toBe(1);
  });
});

describe("tapProgressStream error propagation", () => {
  it("propagates a source error to the consumer instead of swallowing it", async () => {
    const boom = new Error("source exploded");
    const source = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.error(boom);
      },
    });
    const throttle = new ProgressBumpThrottle(60_000);
    const reader = tapProgressStream(
      source,
      "task1",
      throttle,
      () => {},
    ).getReader();
    // Drain until the rejection surfaces; the error must reach the consumer
    // unchanged — a tap that swallowed it would end the stream cleanly and
    // silently truncate the run.
    let caught: unknown;
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
  });
});
