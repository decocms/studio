import type { UIMessageChunk } from "ai";
import { describe, expect, test } from "bun:test";
import type { JetStreamClient } from "@nats-io/jetstream";
import {
  readProjectorRunLog,
  reconstructProjectorRun,
  type ProjectorRetainedMessage,
} from "./projector-run-log";

const enc = new TextEncoder();
const msg = (
  msgId: string,
  payload: unknown,
  headers?: Record<string, string>,
): ProjectorRetainedMessage => ({
  subject: "decopilot.stream.run_1",
  msgId,
  data: enc.encode(JSON.stringify(payload)),
  headers: { get: (name: string) => headers?.[name] },
});

describe("reconstructProjectorRun", () => {
  test("filters by fence and returns ordered chunks", () => {
    const result = reconstructProjectorRun({
      runId: "run_1",
      fenceToken: "fence_a",
      finalSeq: 3,
      messages: [
        msg("run_1:old:1", { p: { type: "start", old: true } }),
        msg("run_1:fence_a:2", { p: { type: "text-delta", delta: "hi" } }),
        msg("run_1:fence_a:1", { p: { type: "start" } }),
        msg("run_1:fence_a:3", { p: { type: "finish", finishReason: "stop" } }),
        msg("run_1:fence_a:done:3", { done: true, finalSeq: 3 }),
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chunks.map((c) => c.type)).toEqual([
        "start",
        "text-delta",
        "finish",
      ]);
    }
  });

  test("fails when a required sequence is missing", () => {
    const result = reconstructProjectorRun({
      runId: "run_1",
      fenceToken: "fence_a",
      finalSeq: 3,
      messages: [
        msg("run_1:fence_a:1", { p: { type: "start" } }),
        msg("run_1:fence_a:3", { p: { type: "finish" } }),
        msg("run_1:fence_a:done:3", { done: true, finalSeq: 3 }),
      ],
    });

    expect(result).toEqual({ ok: false, error: "missing seq 2" });
  });

  test("reassembles fragmented logical chunks", () => {
    const full = JSON.stringify({ p: { type: "text-delta", delta: "hello" } });
    const a = full.slice(0, 18);
    const b = full.slice(18);
    const result = reconstructProjectorRun({
      runId: "run_1",
      fenceToken: "fence_a",
      finalSeq: 1,
      messages: [
        {
          subject: "decopilot.stream.run_1",
          msgId: "run_1:fence_a:1:frag:0",
          data: enc.encode(a),
          headers: {
            get: (name) =>
              name === "Dp-Frag-Total"
                ? "2"
                : name === "Dp-Frag-Idx"
                  ? "0"
                  : undefined,
          },
        },
        {
          subject: "decopilot.stream.run_1",
          msgId: "run_1:fence_a:1:frag:1",
          data: enc.encode(b),
          headers: {
            get: (name) =>
              name === "Dp-Frag-Total"
                ? "2"
                : name === "Dp-Frag-Idx"
                  ? "1"
                  : undefined,
          },
        },
        msg("run_1:fence_a:done:1", { done: true, finalSeq: 1 }),
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.chunks).toEqual([
        { type: "text-delta", delta: "hello" } as UIMessageChunk,
      ]);
  });
});

// ---------------------------------------------------------------------------
// readProjectorRunLog — bounded ordered reader over a JetStream subscription.
//
// Following the convention already used by projector-consumer.test.ts and
// nats-stream-buffer.test.ts: instead of mocking our own code, we feed the
// reader a controlled async-iterable subscription (the only JetStream surface
// it touches is `js.consumers.get(...).consume()` → an async iterable with
// `.stop()`).
// That is a controlled *input source*, the same shape NATS hands us, so we can
// assert the reader's real ordering / early-exit / idle-timeout behaviour
// without a live NATS server.
// ---------------------------------------------------------------------------

interface ReaderMsg {
  subject: string;
  data: Uint8Array;
  headers?: { get(name: string): string | undefined };
}

function fakeJetStream(emit: (push: (m: ReaderMsg) => void) => void): {
  js: JetStreamClient;
  unsubscribed: () => boolean;
} {
  let resolveNext: ((r: IteratorResult<ReaderMsg>) => void) | null = null;
  const queue: ReaderMsg[] = [];
  let done = false;
  let unsub = false;

  const push = (m: ReaderMsg) => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: m, done: false });
    } else {
      queue.push(m);
    }
  };

  const sub = {
    stop() {
      unsub = true;
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as unknown as ReaderMsg, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<ReaderMsg>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({
              value: undefined as unknown as ReaderMsg,
              done: true,
            });
          }
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
      };
    },
  };

  const js = {
    consumers: { get: async () => ({ consume: async () => sub }) },
  } as unknown as JetStreamClient;

  emit(push);
  return { js, unsubscribed: () => unsub };
}

function readerMsg(
  msgId: string,
  payload: unknown,
  headers?: Record<string, string>,
): ReaderMsg {
  const all: Record<string, string> = { "Nats-Msg-Id": msgId, ...headers };
  return {
    subject: "decopilot.stream.run_1",
    data: enc.encode(JSON.stringify(payload)),
    headers: { get: (name: string) => all[name] },
  };
}

describe("readProjectorRunLog", () => {
  test("returns reconstructed chunks and unsubscribes once the run is complete", async () => {
    const { js, unsubscribed } = fakeJetStream((push) => {
      push(readerMsg("run_1:fence_a:1", { p: { type: "start" } }));
      push(
        readerMsg("run_1:fence_a:2", {
          p: { type: "text-delta", delta: "hi" },
        }),
      );
      push(
        readerMsg("run_1:fence_a:3", {
          p: { type: "finish", finishReason: "stop" },
        }),
      );
      push(readerMsg("run_1:fence_a:done:3", { done: true, finalSeq: 3 }));
    });

    const result = await readProjectorRunLog({
      js,
      runId: "run_1",
      fenceToken: "fence_a",
      finalSeq: 3,
      idleTimeoutMs: 1000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chunks.map((c) => c.type)).toEqual([
        "start",
        "text-delta",
        "finish",
      ]);
    }
    expect(unsubscribed()).toBe(true);
  });

  test("falls back to a best-effort reconstruct when the log is idle and incomplete", async () => {
    const { js } = fakeJetStream((push) => {
      // The {done} marker never arrives; the idle timeout fires.
      push(readerMsg("run_1:fence_a:1", { p: { type: "start" } }));
    });

    const result = await readProjectorRunLog({
      js,
      runId: "run_1",
      fenceToken: "fence_a",
      finalSeq: 3,
      idleTimeoutMs: 10,
    });

    expect(result).toEqual({ ok: false, error: "missing done" });
  });
});
