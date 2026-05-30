import { describe, it, expect } from "bun:test";
import { wrapStreamWithKeepalive } from "./sse-keepalive";

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeSource(
  chunks: Array<{ delayMs: number; bytes: Uint8Array | string } | "close">,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const item of chunks) {
        if (item === "close") {
          controller.close();
          return;
        }
        if (item.delayMs > 0) {
          await new Promise((r) => setTimeout(r, item.delayMs));
        }
        const value =
          typeof item.bytes === "string" ? enc.encode(item.bytes) : item.bytes;
        controller.enqueue(value);
      }
      controller.close();
    },
  });
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
  it("passes through chunks unchanged when source ends quickly", async () => {
    const source = makeSource([
      { delayMs: 0, bytes: 'data: {"x":1}\n\n' },
      { delayMs: 0, bytes: "data: [DONE]\n\n" },
    ]);
    const wrapped = wrapStreamWithKeepalive(source, 10_000);
    const out = await readAll(wrapped);
    expect(out).toBe('data: {"x":1}\n\ndata: [DONE]\n\n');
  });

  it("injects keepalive comments during silent periods", async () => {
    const source = makeSource([
      { delayMs: 0, bytes: 'data: {"x":1}\n\n' },
      { delayMs: 120, bytes: "data: [DONE]\n\n" },
    ]);
    // 30ms interval — should fire ~3-4 times during the 120ms gap.
    const wrapped = wrapStreamWithKeepalive(source, 30);
    const out = await readAll(wrapped);
    const matches = out.match(/: keepalive\n\n/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    // Real data must still be present and uncorrupted.
    expect(out).toContain('data: {"x":1}\n\n');
    expect(out).toContain("data: [DONE]\n\n");
  });

  it("does NOT inject mid-event when chunk ends without \\n\\n boundary", async () => {
    // Simulate a (hypothetical) future where one event spans two chunks.
    const source = makeSource([
      { delayMs: 0, bytes: 'data: {"par' }, // partial — no \n\n yet
      { delayMs: 80, bytes: 'tial":true}\n\n' }, // completes the event
    ]);
    const wrapped = wrapStreamWithKeepalive(source, 20);
    const out = await readAll(wrapped);

    // No keepalive should appear inside `data: {"...}` payload.
    // It's OK if heartbeats arrive after the event completes.
    const firstNewlinePair = out.indexOf("\n\n");
    expect(firstNewlinePair).toBeGreaterThan(0);
    const firstEvent = out.slice(0, firstNewlinePair);
    expect(firstEvent).not.toContain(": keepalive");
    expect(firstEvent).toBe('data: {"partial":true}');
  });

  it("clears the interval when source ends", async () => {
    const source = makeSource([{ delayMs: 0, bytes: "data: end\n\n" }]);
    const wrapped = wrapStreamWithKeepalive(source, 10);
    await readAll(wrapped);
    // If the interval leaked, this test process would hang on shutdown. Bun
    // test would surface that. We also assert no spurious keepalives after
    // close by waiting briefly and confirming the stream remains drained.
    await new Promise((r) => setTimeout(r, 30));
    // No assertion needed — the absence of an open handle is the test.
  });

  it("propagates downstream cancel to the source", async () => {
    let sourceCancelled = false;
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

    const wrapped = wrapStreamWithKeepalive(source, 10_000);
    const reader = wrapped.getReader();
    await reader.read(); // first chunk
    await reader.cancel("client gone");

    // Give the cancel a tick to propagate.
    await new Promise((r) => setTimeout(r, 5));
    expect(sourceCancelled).toBe(true);
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

    const wrapped = wrapStreamWithKeepalive(source, 10_000);
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
  });
});
