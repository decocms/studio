import { describe, expect, it } from "bun:test";
import {
  type KeepaliveTimerFns,
  wrapStreamWithKeepalive,
} from "./sse-keepalive";

// No real timers anywhere: the interval is a manually-fired ticker and the
// source is a test-pushed stream. Deterministic under any CI load (the
// previous small-real-interval style flaked on the loaded parallel runner),
// and outputs assert exactly.

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Manually-driven source: the test pushes chunks and closes explicitly. */
function manualSource() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (bytes: string) => controller.enqueue(enc.encode(bytes)),
    close: () => controller.close(),
  };
}

/** Manually-fired interval: `tick()` is one keepalive interval elapsing. */
function manualTicker() {
  let callback: (() => void) | null = null;
  let cleared = false;
  const timerFns: KeepaliveTimerFns = {
    setInterval: (fn) => {
      callback = fn;
      return "handle";
    },
    clearInterval: () => {
      callback = null;
      cleared = true;
    },
  };
  return {
    timerFns,
    tick: () => callback?.(),
    wasCleared: () => cleared,
  };
}

/** Let pushed chunks flow through the wrapper's read loop (microtasks only —
 *  load-independent, unlike real timers). */
async function drain() {
  for (let i = 0; i < 32; i++) await Promise.resolve();
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

describe("wrapStreamWithKeepalive", () => {
  it("passes through chunks unchanged when no interval elapses", async () => {
    const source = manualSource();
    const ticker = manualTicker();
    const wrapped = wrapStreamWithKeepalive(
      source.stream,
      10_000,
      ticker.timerFns,
    );
    const reading = readAll(wrapped);
    source.push('data: {"x":1}\n\n');
    source.push("data: [DONE]\n\n");
    source.close();
    expect(await reading).toBe('data: {"x":1}\n\ndata: [DONE]\n\n');
  });

  it("injects keepalive comments during silent periods", async () => {
    const source = manualSource();
    const ticker = manualTicker();
    const wrapped = wrapStreamWithKeepalive(
      source.stream,
      10_000,
      ticker.timerFns,
    );
    const reading = readAll(wrapped);
    source.push('data: {"x":1}\n\n');
    await drain();
    ticker.tick(); // one silent interval elapses
    ticker.tick(); // and another
    source.push("data: [DONE]\n\n");
    source.close();
    // Exact interleaving: chunk, two keepalives, final chunk.
    expect(await reading).toBe(
      'data: {"x":1}\n\n: keepalive\n\n: keepalive\n\ndata: [DONE]\n\n',
    );
  });

  it("does NOT inject mid-event when chunk ends without \\n\\n boundary", async () => {
    const source = manualSource();
    const ticker = manualTicker();
    const wrapped = wrapStreamWithKeepalive(
      source.stream,
      10_000,
      ticker.timerFns,
    );
    const reading = readAll(wrapped);
    source.push('data: {"par'); // partial — no \n\n yet
    await drain();
    ticker.tick(); // interval elapses mid-event — must be suppressed
    source.push('tial":true}\n\n'); // completes the event
    await drain();
    ticker.tick(); // boundary reached — this one may fire
    source.close();
    expect(await reading).toBe('data: {"partial":true}\n\n: keepalive\n\n');
  });

  it("clears the interval when source ends", async () => {
    const source = manualSource();
    const ticker = manualTicker();
    const wrapped = wrapStreamWithKeepalive(
      source.stream,
      10_000,
      ticker.timerFns,
    );
    const reading = readAll(wrapped);
    source.push("data: end\n\n");
    source.close();
    await reading;
    expect(ticker.wasCleared()).toBe(true);
    // A tick after clear is a no-op, not a crash or a stray enqueue.
    ticker.tick();
  });

  it("propagates downstream cancel to the source and clears the interval", async () => {
    let sourceCancelled = false;
    const ticker = manualTicker();
    const source = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode("data: hi\n\n"));
        // Hold the stream open indefinitely; rely on cancel propagation.
        await new Promise(() => {});
      },
      cancel() {
        sourceCancelled = true;
      },
    });

    const wrapped = wrapStreamWithKeepalive(source, 10_000, ticker.timerFns);
    const reader = wrapped.getReader();
    await reader.read(); // first chunk
    await reader.cancel("client gone");
    await drain();
    expect(sourceCancelled).toBe(true);
    expect(ticker.wasCleared()).toBe(true);
  });

  it("propagates source errors", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("data: ok\n\n"));
        // Defer the error so the wrapper has a tick to consume the first
        // chunk before the rejection arrives. Modeling a real mid-stream
        // failure is what we care about, not a synchronous error in start().
        queueMicrotask(() => controller.error(new Error("boom")));
      },
    });

    const ticker = manualTicker();
    const wrapped = wrapStreamWithKeepalive(source, 10_000, ticker.timerFns);
    const reader = wrapped.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    let caught: unknown = null;
    try {
      await reader.read();
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof Error && (caught as Error).message).toBe("boom");
    expect(ticker.wasCleared()).toBe(true);
  });
});
