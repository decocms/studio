import { describe, it, expect, mock } from "bun:test";
import { NatsStreamBuffer } from "./nats-stream-buffer";

type DeferredMsg = { data: Uint8Array };

function createControlledSubscription() {
  const queue: Array<{ done: false; value: DeferredMsg } | { done: true }> = [];
  const waiters: Array<
    (
      v: { done: false; value: DeferredMsg } | { done: true; value: undefined },
    ) => void
  > = [];

  const push = (value: DeferredMsg) => {
    const next = waiters.shift();
    if (next) next({ done: false, value });
    else queue.push({ done: false, value });
  };

  const end = () => {
    const next = waiters.shift();
    if (next) next({ done: true, value: undefined });
    else queue.push({ done: true });
  };

  const sub = {
    unsubscribe: mock(() => {}),
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<
          { done: false; value: DeferredMsg } | { done: true; value: undefined }
        > {
          const queued = queue.shift();
          if (queued) {
            if (queued.done) {
              return Promise.resolve({ done: true, value: undefined });
            }
            return Promise.resolve(queued);
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
        return(): Promise<{ done: true; value: undefined }> {
          waiters.splice(0).forEach((w) => w({ done: true, value: undefined }));
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };

  return { sub, push, end };
}

function bufferWith(subscribeFn: () => Promise<unknown>) {
  const mockJs = { subscribe: mockOf(subscribeFn) };
  const buffer = new NatsStreamBuffer({
    getConnection: () => ({}) as never,
    getJetStream: () => mockJs as never,
  });
  // Bypass init() — inject the JetStream client directly.
  (buffer as unknown as { js: unknown }).js = mockJs;
  return buffer;
}

function mockOf<T extends (...args: never[]) => unknown>(fn: T): T {
  return mock(fn) as unknown as T;
}

async function readAll(stream: ReadableStream): Promise<unknown[]> {
  const reader = stream.getReader();
  const out: unknown[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("NatsStreamBuffer", () => {
  it("purge is a no-op when jsm is not initialized (no throw)", () => {
    const buffer = new NatsStreamBuffer({
      getConnection: () => ({}) as never,
      getJetStream: () => ({}) as never,
    });
    expect(() => buffer.purge("any")).not.toThrow();
  });

  it("teardown clears references", () => {
    const buffer = new NatsStreamBuffer({
      getConnection: () => ({}) as never,
      getJetStream: () => ({}) as never,
    });
    expect(() => buffer.teardown()).not.toThrow();
  });

  it("init creates or updates stream when connection is available", async () => {
    const streamInfoMock = mock(() => Promise.resolve({}));
    const streamUpdateMock = mock(() => Promise.resolve({}));
    const streamAddMock = mock(() => Promise.resolve({}));

    const mockJsm = {
      streams: {
        info: streamInfoMock,
        update: streamUpdateMock,
        add: streamAddMock,
      },
    };

    const mockNc = {
      jetstreamManager: mock(() => Promise.resolve(mockJsm)),
    };

    const mockJs = {} as never;

    const buffer = new NatsStreamBuffer({
      getConnection: () => mockNc as never,
      getJetStream: () => mockJs,
    });

    await buffer.init();

    expect(mockNc.jetstreamManager).toHaveBeenCalledTimes(1);
    expect(streamInfoMock).toHaveBeenCalledWith("DECOPILOT_STREAMS");
    expect(streamUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("init falls back to add when info throws", async () => {
    const streamInfoMock = mock(() =>
      Promise.reject(new Error("stream not found")),
    );
    const streamUpdateMock = mock(() => Promise.resolve({}));
    const streamAddMock = mock(() => Promise.resolve({}));

    const mockJsm = {
      streams: {
        info: streamInfoMock,
        update: streamUpdateMock,
        add: streamAddMock,
      },
    };

    const mockNc = {
      jetstreamManager: mock(() => Promise.resolve(mockJsm)),
    };

    const buffer = new NatsStreamBuffer({
      getConnection: () => mockNc as never,
      getJetStream: () => ({}) as never,
    });

    await buffer.init();

    expect(streamAddMock).toHaveBeenCalledTimes(1);
  });

  describe("createTailStream", () => {
    function encodeMsg(payload: unknown): DeferredMsg {
      return { data: new TextEncoder().encode(JSON.stringify(payload)) };
    }

    it("returns null when JetStream is unavailable", async () => {
      const buffer = new NatsStreamBuffer({
        getConnection: () => null,
        getJetStream: () => null,
      });
      const result = await buffer.createTailStream("task-1");
      expect(result).toBeNull();
    });

    it("yields buffered chunks and closes on done marker", async () => {
      const { sub, push, end } = createControlledSubscription();
      const buffer = bufferWith(() => Promise.resolve(sub));

      const stream = await buffer.createTailStream("task-1");
      expect(stream).not.toBeNull();

      push(encodeMsg({ p: "chunk-1" }));
      push(encodeMsg({ p: "chunk-2" }));
      push(encodeMsg({ done: true }));
      end();

      const chunks = await readAll(stream!);
      expect(chunks).toEqual(["chunk-1", "chunk-2"]);
      expect(sub.unsubscribe).toHaveBeenCalled();
    });

    it("stays open across long silent gaps between chunks", async () => {
      // Regression: previously a 30s pull timeout would close the SSE
      // stream prematurely with [DONE] when the producer (e.g. deep
      // research polling Gemini) went silent between progress chunks.
      const { sub, push, end } = createControlledSubscription();
      const buffer = bufferWith(() => Promise.resolve(sub));

      const stream = await buffer.createTailStream("task-1");
      const reader = stream!.getReader();

      push(encodeMsg({ p: "before-gap" }));
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value).toBe("before-gap");

      // Simulate a long silent period. The pull is now awaiting iter.next()
      // with no incoming messages. Kick off the next read and confirm it
      // does NOT resolve while the subscription is idle.
      let secondResolved = false;
      const secondP = reader.read().then((r) => {
        secondResolved = true;
        return r as { done: boolean; value: unknown };
      });

      // Yield to the event loop and a short timer; nothing should resolve.
      await new Promise((r) => setTimeout(r, 50));
      expect(secondResolved).toBe(false);

      // After the gap, a new chunk arrives — it must flow through.
      push(encodeMsg({ p: "after-gap" }));
      const second = await secondP;
      expect(second.done).toBe(false);
      expect(second.value).toBe("after-gap");

      push(encodeMsg({ done: true }));
      end();
      const tail = await reader.read();
      expect(tail.done).toBe(true);
    });

    it("skips malformed messages and continues", async () => {
      const { sub, push, end } = createControlledSubscription();
      const buffer = bufferWith(() => Promise.resolve(sub));

      const stream = await buffer.createTailStream("task-1");

      // Malformed JSON between two valid chunks.
      push(encodeMsg({ p: "ok-1" }));
      push({ data: new TextEncoder().encode("not-json{{{") });
      push(encodeMsg({ p: "ok-2" }));
      push(encodeMsg({ done: true }));
      end();

      const chunks = await readAll(stream!);
      expect(chunks).toEqual(["ok-1", "ok-2"]);
    });

    it("cleans up when consumer cancels", async () => {
      const { sub, push } = createControlledSubscription();
      const buffer = bufferWith(() => Promise.resolve(sub));

      const stream = await buffer.createTailStream("task-1");
      const reader = stream!.getReader();

      push(encodeMsg({ p: "first" }));
      await reader.read();

      await reader.cancel();
      expect(sub.unsubscribe).toHaveBeenCalled();
    });

    it("returns null when subscribe throws", async () => {
      const buffer = bufferWith(() =>
        Promise.reject(new Error("subscribe failed")),
      );
      const stream = await buffer.createTailStream("task-1");
      expect(stream).toBeNull();
    });

    it("persistent mode keeps tailing past the done sentinel", async () => {
      // Subscribe-model behavior: one connection covers multiple runs in
      // the thread. The {done} marker between runs must not close it.
      const { sub, push, end } = createControlledSubscription();
      const buffer = bufferWith(() => Promise.resolve(sub));

      const stream = await buffer.createTailStream("task-1", undefined, {
        closeOnDone: false,
      });
      const reader = stream!.getReader();

      // Run 1 chunks + done.
      push(encodeMsg({ p: "run1-a" }));
      push(encodeMsg({ p: "run1-b" }));
      push(encodeMsg({ done: true }));
      // Run 2 chunks — subscriber should keep receiving.
      push(encodeMsg({ p: "run2-a" }));

      const a = await reader.read();
      expect(a.value).toBe("run1-a");
      const b = await reader.read();
      expect(b.value).toBe("run1-b");
      // {done} from run 1 is skipped — next read yields run 2's first chunk.
      const c = await reader.read();
      expect(c.done).toBe(false);
      expect(c.value).toBe("run2-a");

      // Closing the upstream subscription does terminate the reader.
      end();
      const tail = await reader.read();
      expect(tail.done).toBe(true);
    });
  });
});
