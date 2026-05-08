import { describe, expect, it, mock, spyOn } from "bun:test";
import { guardResponseStream } from "./stream-guard";

const collect = async (response: Response): Promise<string> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
};

describe("guardResponseStream", () => {
  it("passes a normal stream through unchanged", async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("hello "));
        controller.enqueue(encoder.encode("world"));
        controller.close();
      },
    });
    const original = new Response(source, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const guarded = guardResponseStream(original, "test:normal");

    expect(guarded.status).toBe(200);
    expect(guarded.headers.get("content-type")).toBe("text/event-stream");
    expect(await collect(guarded)).toBe("hello world");
  });

  it("closes cleanly when the source errors mid-stream", async () => {
    const encoder = new TextEncoder();
    let phase = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        // First pull: emit a chunk. Second pull: error.
        // Splitting across pulls ensures the consumer sees the chunk before
        // the error surfaces, mirroring the realistic case where some bytes
        // have already gone over the wire when the upstream fails.
        if (phase === 0) {
          phase = 1;
          controller.enqueue(encoder.encode("partial"));
        } else {
          controller.error(new Error("upstream exploded"));
        }
      },
    });
    const original = new Response(source, { status: 200 });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    const guarded = guardResponseStream(original, "test:erroring");

    // The guard must resolve (clean close), not reject — that's the whole point
    const body = await collect(guarded);
    expect(body).toBe("partial");
    expect(errSpy).toHaveBeenCalled();
    const firstCall = errSpy.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(String(firstCall![0])).toContain("test:erroring");
    expect(String(firstCall![1])).toContain("upstream exploded");

    errSpy.mockRestore();
  });

  it("returns the response unchanged when there is no body", () => {
    const original = new Response(null, { status: 204 });
    const guarded = guardResponseStream(original, "test:empty");
    expect(guarded).toBe(original);
  });

  it("forwards cancellation upstream", async () => {
    const cancelFn = mock(() => {});
    const source = new ReadableStream<Uint8Array>({
      start() {
        // never push, never close — keep the stream open until cancellation
      },
      cancel: cancelFn,
    });
    const original = new Response(source, { status: 200 });

    const guarded = guardResponseStream(original, "test:cancel");
    // Touch the body so the guard's start() runs and acquires the reader
    // before we cancel.
    const reader = guarded.body!.getReader();
    await reader.cancel("client gone");

    expect(cancelFn).toHaveBeenCalledWith("client gone");
  });
});
