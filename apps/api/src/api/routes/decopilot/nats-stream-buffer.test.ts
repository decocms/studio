import { describe, it, expect, mock, test } from "bun:test";
import { StorageType } from "@nats-io/jetstream";
import { decopilotStreamConfig, NatsStreamBuffer } from "./nats-stream-buffer";

type DeferredMsg = {
  data: Uint8Array;
  headers?: { get(name: string): string | undefined };
};

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
    stop: mock(() => {}),
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

function bufferWith(consumeFn: () => Promise<unknown>) {
  // v3 ordered-consumer fake: createTailStream calls
  // `js.consumers.get(stream, opts)` then `.consume()`.
  const mockJs = {
    consumers: { get: async () => ({ consume: mockOf(consumeFn) }) },
  };
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

test("decopilot stream is file-backed with a dedup window and SLA retention", () => {
  const c = decopilotStreamConfig();
  expect(c.storage).toBe(StorageType.File);
  expect(c.duplicate_window).toBeGreaterThanOrEqual(2 * 60 * 1_000_000_000); // >= 2min (ns)
  // Retention must outlast a day-long desktop run so seq 1 survives until the
  // terminal projection re-reads [1..finalSeq].
  expect(c.max_age).toBeGreaterThanOrEqual(24 * 60 * 60 * 1_000_000_000); // >= 24h
  expect(c.max_msgs_per_subject).toBeGreaterThanOrEqual(500_000);
  expect(c.max_bytes).toBeGreaterThanOrEqual(4 * 1024 * 1024 * 1024); // >= 4GB
});

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

    const getJetStreamManager = mock(() => Promise.resolve(mockJsm));

    const mockJs = {} as never;

    const buffer = new NatsStreamBuffer({
      getConnection: () => ({}) as never,
      getJetStream: () => mockJs,
      getJetStreamManager: getJetStreamManager as never,
    });

    await buffer.init();

    expect(getJetStreamManager).toHaveBeenCalledTimes(1);
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

    const buffer = new NatsStreamBuffer({
      getConnection: () => ({}) as never,
      getJetStream: () => ({}) as never,
      getJetStreamManager: (() => Promise.resolve(mockJsm)) as never,
    });

    await buffer.init();

    expect(streamAddMock).toHaveBeenCalledTimes(1);
  });

  it("init recreates the stream (delete+add) on a storage mismatch", async () => {
    // JetStream cannot change `storage` in place, so flipping the legacy
    // Memory stream to File makes `update` reject. The ephemeral run-scratch
    // stream is dropped and recreated file-backed.
    const streamInfoMock = mock(() => Promise.resolve({}));
    const streamUpdateMock = mock(() =>
      Promise.reject(
        new Error("stream configuration update can not change storage type"),
      ),
    );
    const streamDeleteMock = mock(() => Promise.resolve(true));
    const streamAddMock = mock(() => Promise.resolve({}));

    const mockJsm = {
      streams: {
        info: streamInfoMock,
        update: streamUpdateMock,
        delete: streamDeleteMock,
        add: streamAddMock,
      },
    };

    const buffer = new NatsStreamBuffer({
      getConnection: () => ({}) as never,
      getJetStream: () => ({}) as never,
      getJetStreamManager: (() => Promise.resolve(mockJsm)) as never,
    });

    await buffer.init();

    expect(streamUpdateMock).toHaveBeenCalledTimes(1);
    expect(streamDeleteMock).toHaveBeenCalledWith("DECOPILOT_STREAMS");
    expect(streamAddMock).toHaveBeenCalledTimes(1);
  });

  it("init retries a transient JS-API timeout instead of wedging js=null", async () => {
    // Regression: a single startup timeout on the JS-API handshake used to
    // leave `this.js` null for the pod's whole life (init only re-ran on a
    // reconnect that never came), failing every run at publishRawChunk.
    let attempts = 0;
    const streamInfoMock = mock(() => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error("timeout"));
      return Promise.resolve({});
    });
    const mockJsm = {
      streams: {
        info: streamInfoMock,
        update: mock(() => Promise.resolve({})),
        add: mock(() => Promise.resolve({})),
      },
    };
    const publishMock = mock(() => Promise.resolve({ seq: 1 }));

    const buffer = new NatsStreamBuffer({
      getConnection: () => ({}) as never,
      getJetStream: () => ({ publish: publishMock }) as never,
      getJetStreamManager: (() => Promise.resolve(mockJsm)) as never,
    });

    await buffer.init();

    // Retried past the transient failure and then wired up a live client.
    expect(streamInfoMock).toHaveBeenCalledTimes(2);
    const ok = await buffer.publishRawChunk("thrd_x", {
      type: "text",
    } as never);
    expect(ok).toBe(true);
    expect(publishMock).toHaveBeenCalled();
  });

  it("init does NOT retry a non-transient (semantic) error", async () => {
    const getJetStreamManager = mock(() =>
      Promise.resolve({
        streams: {
          info: mock(() => Promise.reject(new Error("invalid stream config"))),
          update: mock(() => Promise.resolve({})),
          add: mock(() => Promise.resolve({})),
        },
      }),
    );

    const buffer = new NatsStreamBuffer({
      getConnection: () => ({}) as never,
      getJetStream: () => ({}) as never,
      getJetStreamManager: getJetStreamManager as never,
    });

    await expect(buffer.init()).rejects.toThrow();
    // Failed fast: exactly one attempt, no exponential-backoff loop.
    expect(getJetStreamManager).toHaveBeenCalledTimes(1);
  });

  describe("createTailStream", () => {
    function encodeMsg(payload: unknown): DeferredMsg {
      return { data: new TextEncoder().encode(JSON.stringify(payload)) };
    }

    // Mirror the producer's fragment headers (see `publishChunk`): split the
    // encoded `{ p: value }` bytes into `parts` ordered fragment messages.
    function fragmentChunk(value: unknown, parts: number): DeferredMsg[] {
      const bytes = new TextEncoder().encode(JSON.stringify({ p: value }));
      const sliceSize = Math.ceil(bytes.length / parts);
      const msgs: DeferredMsg[] = [];
      for (let i = 0; i < parts; i++) {
        const data = bytes.slice(i * sliceSize, (i + 1) * sliceSize);
        const hdr: Record<string, string> = {
          "Dp-Frag-Idx": String(i),
          "Dp-Frag-Total": String(parts),
        };
        msgs.push({ data, headers: { get: (name) => hdr[name] } });
      }
      return msgs;
    }

    it("reassembles a fragmented chunk byte-exact", async () => {
      const { sub, push, end } = createControlledSubscription();
      const buffer = bufferWith(() => Promise.resolve(sub));
      const stream = await buffer.createTailStream("task-1");

      const value = { type: "text-delta", text: "x".repeat(200) };
      for (const f of fragmentChunk(value, 4)) push(f);
      end();

      const chunks = await readAll(stream!);
      expect(chunks).toEqual([value]);
    });

    it("keeps consecutive same-total fragmented chunks separate", async () => {
      const { sub, push, end } = createControlledSubscription();
      const buffer = bufferWith(() => Promise.resolve(sub));
      const stream = await buffer.createTailStream("task-1");

      const a = "A".repeat(120);
      const b = "B".repeat(120);
      for (const f of fragmentChunk(a, 3)) push(f);
      for (const f of fragmentChunk(b, 3)) push(f);
      end();

      const chunks = await readAll(stream!);
      expect(chunks).toEqual([a, b]);
    });

    it("drops a mid-sequence fragment join without poisoning the next chunk", async () => {
      // A `deliverPolicy: "new"` subscriber can land mid-fragment, seeing
      // index>0 first with no index-0 anchor. Those strays must be discarded
      // so they don't corrupt the next complete chunk.
      const { sub, push, end } = createControlledSubscription();
      const buffer = bufferWith(() => Promise.resolve(sub));
      const stream = await buffer.createTailStream("task-1");

      const [, stale1, stale2] = fragmentChunk("X".repeat(120), 3);
      push(stale1!); // joined mid-sequence — index 0 never seen
      push(stale2!);
      const good = "good-payload-after-join";
      for (const f of fragmentChunk(good, 3)) push(f);
      end();

      const chunks = await readAll(stream!);
      expect(chunks).toEqual([good]);
    });

    it("drops an incomplete chunk (lost fragment) and recovers on the next", async () => {
      // A failed middle publish leaves a gap. The stale accumulator must not
      // bleed into a following same-total chunk.
      const { sub, push, end } = createControlledSubscription();
      const buffer = bufferWith(() => Promise.resolve(sub));
      const stream = await buffer.createTailStream("task-1");

      const [lost0, , lost2] = fragmentChunk("Y".repeat(120), 3);
      push(lost0!); // index 1 publish "failed" — never arrives
      push(lost2!);
      const recovered = "recovered-after-loss";
      for (const f of fragmentChunk(recovered, 3)) push(f);
      end();

      const chunks = await readAll(stream!);
      expect(chunks).toEqual([recovered]);
    });

    it("returns null when JetStream is unavailable", async () => {
      const buffer = new NatsStreamBuffer({
        getConnection: () => null,
        getJetStream: () => null,
      });
      const result = await buffer.createTailStream("task-1");
      expect(result).toBeNull();
    });

    it("yields buffered chunks and closes when the subscription ends", async () => {
      const { sub, push, end } = createControlledSubscription();
      const buffer = bufferWith(() => Promise.resolve(sub));

      const stream = await buffer.createTailStream("task-1");
      expect(stream).not.toBeNull();

      push(encodeMsg({ p: "chunk-1" }));
      push(encodeMsg({ p: "chunk-2" }));
      end();

      const chunks = await readAll(stream!);
      expect(chunks).toEqual(["chunk-1", "chunk-2"]);
      expect(sub.stop).toHaveBeenCalled();
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
      expect(sub.stop).toHaveBeenCalled();
    });

    it("returns null when subscribe throws", async () => {
      const buffer = bufferWith(() =>
        Promise.reject(new Error("subscribe failed")),
      );
      const stream = await buffer.createTailStream("task-1");
      expect(stream).toBeNull();
    });

    it("closes on the {done} sentinel when closeOnDone is set", async () => {
      // Used by `dispatchRunAndWait` to block on a single run's completion.
      // The default cross-run behavior must NOT apply here.
      const { sub, push } = createControlledSubscription();
      const buffer = bufferWith(() => Promise.resolve(sub));

      const stream = await buffer.createTailStream("task-1", undefined, {
        closeOnDone: true,
      });

      push(encodeMsg({ p: "chunk-1" }));
      push(encodeMsg({ p: "chunk-2" }));
      push(encodeMsg({ done: true }));
      // Any chunk published after `done` must not be observed by this
      // subscriber — the stream is already terminating.
      push(encodeMsg({ p: "after-done" }));

      const chunks = await readAll(stream!);
      expect(chunks).toEqual(["chunk-1", "chunk-2"]);
      expect(sub.stop).toHaveBeenCalled();
    });

    it("swallows the {done} sentinel and keeps tailing across runs", async () => {
      // Subscribe-model behavior: one connection covers multiple runs in
      // the thread. The producer's {done} marker between runs must not
      // surface to the client — clients detect run boundaries via the
      // AI-SDK `{type: "finish"}` chunk inside the data stream.
      const { sub, push, end } = createControlledSubscription();
      const buffer = bufferWith(() => Promise.resolve(sub));

      const stream = await buffer.createTailStream("task-1");
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

  describe("pump", () => {
    function bufferForPump() {
      const published: Array<{ subj: string; data: Uint8Array }> = [];
      const mockJs = {
        publish: mockOf((subj: string, data: Uint8Array) => {
          published.push({ subj, data });
          return Promise.resolve({ seq: published.length });
        }),
      };
      const buffer = new NatsStreamBuffer({
        getConnection: () => ({}) as never,
        getJetStream: () => mockJs as never,
      });
      (buffer as unknown as { js: unknown }).js = mockJs;
      return { buffer, published };
    }

    function doneBody(data: Uint8Array): unknown {
      return JSON.parse(new TextDecoder().decode(data));
    }

    it("resolves after a clean drain and publishes the unfenced done sentinel", async () => {
      const { buffer, published } = bufferForPump();
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      await expect(
        buffer.pump(stream, "task-1", new AbortController().signal),
      ).resolves.toBeUndefined();

      expect(published).toHaveLength(1);
      expect(doneBody(published[0]!.data)).toEqual({ done: true });
    });

    it("REJECTS with the stream's error on a mid-stream failure — the old contract silently swallowed this", async () => {
      // Regression for the "pump-swallow gap" (unified-control-plane T2):
      // a mid-stream `ingestRun` failure (healthy JetStream) used to vanish
      // here, so `dispatchRunAndWait` returned as if the run had finished
      // cleanly and no fenced terminal ever reached the stream.
      const { buffer, published } = bufferForPump();
      const boom = new Error("ingest failed mid-stream");
      const stream = new ReadableStream({
        start(controller) {
          controller.error(boom);
        },
      });

      await expect(
        buffer.pump(stream, "task-1", new AbortController().signal),
      ).rejects.toBe(boom);

      // The safety-net unfenced done sentinel STILL goes out (finally block)
      // so a live tail closes instead of hanging — only the caller-facing
      // promise changed, not the wire behavior.
      expect(published).toHaveLength(1);
      expect(doneBody(published[0]!.data)).toEqual({ done: true });
    });

    it("resolves (not rejects) when JetStream is unavailable — nothing to drain", async () => {
      const buffer = new NatsStreamBuffer({
        getConnection: () => null,
        getJetStream: () => null,
      });
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      await expect(
        buffer.pump(stream, "task-1", new AbortController().signal),
      ).resolves.toBeUndefined();
    });
  });

  describe("publishRawChunk", () => {
    function bufferWithPublish() {
      const published: Array<{ subj: string; data: Uint8Array }> = [];
      const mockJs = {
        publish: mockOf((subj: string, data: Uint8Array) => {
          published.push({ subj, data });
          return Promise.resolve({ seq: published.length });
        }),
      };
      const buffer = new NatsStreamBuffer({
        getConnection: () => ({}) as never,
        getJetStream: () => mockJs as never,
      });
      (buffer as unknown as { js: unknown }).js = mockJs;
      return { buffer, published };
    }

    it("publishes the raw chunk under the {p} envelope on the run subject", async () => {
      const { buffer, published } = bufferWithPublish();
      const chunk = { type: "text-delta", id: "t", delta: "hi" };
      await buffer.publishRawChunk("run_1", chunk);
      expect(published).toHaveLength(1);
      expect(published[0]!.subj).toBe("decopilot.stream.run_1");
      expect(JSON.parse(new TextDecoder().decode(published[0]!.data))).toEqual({
        p: chunk,
      });
    });

    it("resolves false when JetStream is unavailable (no throw)", async () => {
      const buffer = new NatsStreamBuffer({
        getConnection: () => null,
        getJetStream: () => null,
      });
      expect(await buffer.publishRawChunk("run_1", { type: "start" })).toBe(
        false,
      );
    });

    it("resolves true after the publish is confirmed", async () => {
      const { buffer } = bufferWithPublish();
      expect(await buffer.publishRawChunk("run_1", { type: "start" })).toBe(
        true,
      );
    });

    it("forwards an explicit msgId for JetStream dedup", async () => {
      const published: Array<{ subj: string; opts?: unknown }> = [];
      const mockJs = {
        publish: mockOf((subj: string, _data: Uint8Array, opts?: unknown) => {
          published.push({ subj, opts });
          return Promise.resolve({ seq: published.length });
        }),
      };
      const buffer = new NatsStreamBuffer({
        getConnection: () => ({}) as never,
        getJetStream: () => mockJs as never,
      });
      (buffer as unknown as { js: unknown }).js = mockJs;
      await buffer.publishRawChunk(
        "run1",
        { type: "text-delta", delta: "x" },
        { fenceToken: "fenceA", seq: 3 },
      );
      expect(published[0]?.opts).toMatchObject({ msgID: "run1:fenceA:3" });
    });
  });

  describe("publishDone", () => {
    it("publishDone writes an awaited done sentinel with a fence-scoped msg id", async () => {
      const publishMock = mock(
        (_subj: string, _data: Uint8Array, _opts?: unknown) =>
          Promise.resolve({ seq: 9 }),
      );
      const buffer = new NatsStreamBuffer({
        getConnection: () => ({}) as never,
        getJetStream: () => ({ publish: publishMock }) as never,
      });
      (buffer as unknown as { js: unknown }).js = { publish: publishMock };

      const ok = await buffer.publishDone("run_1", "fence_a", 7);

      expect(ok).toBe(true);
      expect(publishMock).toHaveBeenCalledTimes(1);
      const [subject, data, opts] = publishMock.mock.calls[0]!;
      expect(subject).toBe("decopilot.stream.run_1");
      expect(JSON.parse(new TextDecoder().decode(data as Uint8Array))).toEqual({
        done: true,
        finalSeq: 7,
      });
      expect(opts).toMatchObject({ msgID: "run_1:fence_a:done:7" });
    });
  });
});
