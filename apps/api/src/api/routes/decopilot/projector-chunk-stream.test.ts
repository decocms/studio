import type { UIMessageChunk } from "ai";
import { describe, expect, test } from "bun:test";
import { sleep } from "@decocms/shared/std";
import { createProjectorChunkStreamFromMessages } from "./projector-chunk-stream";
import { StreamIdleTimeoutError } from "./nats-chunk-source";

const enc = new TextEncoder();

type Msg = {
  subject: string;
  data: Uint8Array;
  headers?: { get(name: string): string | undefined };
};

function msg(
  msgId: string,
  payload: unknown,
  headers?: Record<string, string>,
): Msg {
  const all: Record<string, string> = { "Nats-Msg-Id": msgId, ...headers };
  return {
    subject: "decopilot.stream.run_1",
    data: enc.encode(JSON.stringify(payload)),
    headers: { get: (name) => all[name] },
  };
}

function rawMsg(
  msgId: string,
  raw: string,
  headers?: Record<string, string>,
): Msg {
  const all: Record<string, string> = { "Nats-Msg-Id": msgId, ...headers };
  return {
    subject: "decopilot.stream.run_1",
    data: enc.encode(raw),
    headers: { get: (name) => all[name] },
  };
}

async function readAll(stream: ReadableStream<UIMessageChunk>) {
  const reader = stream.getReader();
  const out: UIMessageChunk[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

describe("createProjectorChunkStreamFromMessages", () => {
  test("reads same-fence NATS chunks from seq 1 and closes on matching done", async () => {
    const stream = createProjectorChunkStreamFromMessages({
      messages: [
        msg("run_1:old:1", { p: { type: "start", old: true } }),
        msg("run_1:fence_a:1", { p: { type: "start" } }),
        msg("run_1:fence_a:2", {
          p: { type: "text-delta", id: "t", delta: "hi" },
        }),
        msg("run_1:fence_a:done:2", { done: true, finalSeq: 2 }),
        msg("run_1:fence_a:3", { p: { type: "finish" } }),
      ],
      runId: "run_1",
      fenceToken: "fence_a",
    });

    expect((await readAll(stream)).map((c) => c.type)).toEqual([
      "start",
      "text-delta",
    ]);
  });

  test("ignores legacy unfenced done and runs past finish to the fenced done", async () => {
    // Background title generation emits a transient `data-title-result` chunk
    // AFTER the assistant `finish` chunk on fast runs. The projector must keep
    // reading to the fenced `done` (whose finalSeq covers it) rather than
    // closing at `finish` — otherwise the title is dropped and the thread stays
    // on "New chat".
    const stream = createProjectorChunkStreamFromMessages({
      messages: [
        msg("run_1:fence_a:1", { p: { type: "start" } }),
        msg("run_1:fence_a:2", {
          p: { type: "tool-output-available", toolCallId: "tc", output: {} },
        }),
        msg("", { done: true }),
        msg("run_1:fence_a:3", { p: { type: "start-step" } }),
        msg("run_1:fence_a:4", {
          p: { type: "text-start", id: "t" },
        }),
        msg("run_1:fence_a:5", {
          p: { type: "text-delta", id: "t", delta: "done" },
        }),
        msg("run_1:fence_a:6", { p: { type: "text-end", id: "t" } }),
        msg("run_1:fence_a:7", {
          p: { type: "finish", finishReason: "stop" },
        }),
        msg("run_1:fence_a:8", {
          p: { type: "data-title-result", data: { title: "Late title" } },
        }),
        msg("run_1:fence_a:done:8", { done: true, finalSeq: 8 }),
      ],
      runId: "run_1",
      fenceToken: "fence_a",
    });

    expect((await readAll(stream)).map((c) => c.type)).toEqual([
      "start",
      "tool-output-available",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
      "data-title-result",
    ]);
  });

  test("errors on a gap before done", async () => {
    const stream = createProjectorChunkStreamFromMessages({
      messages: [
        msg("run_1:fence_a:1", { p: { type: "start" } }),
        msg("run_1:fence_a:3", { p: { type: "finish" } }),
        msg("run_1:fence_a:done:3", { done: true, finalSeq: 3 }),
      ],
      runId: "run_1",
      fenceToken: "fence_a",
    });

    await expect(readAll(stream)).rejects.toThrow("missing seq 2");
  });

  test("reassembles fragmented chunks", async () => {
    const full = JSON.stringify({
      p: { type: "text-delta", id: "t", delta: "hello" },
    });
    const stream = createProjectorChunkStreamFromMessages({
      messages: [
        rawMsg("run_1:fence_a:1:frag:0", full.slice(0, 20), {
          "Dp-Frag-Total": "2",
          "Dp-Frag-Idx": "0",
        }),
        rawMsg("run_1:fence_a:1:frag:1", full.slice(20), {
          "Dp-Frag-Total": "2",
          "Dp-Frag-Idx": "1",
        }),
        msg("run_1:fence_a:done:1", { done: true, finalSeq: 1 }),
      ],
      runId: "run_1",
      fenceToken: "fence_a",
    });

    expect(await readAll(stream)).toEqual([
      { type: "text-delta", id: "t", delta: "hello" },
    ]);
  });

  // unified-control-plane T4: silence on the subject (no events of ANY kind —
  // not just "no done/finish") is the only signal an executor died before/
  // without publishing, now that nothing awaits the child directly (T1-T3).
  // These characterize the liveness-breach signal this module produces and
  // confirm it is a rolling per-message window, not a single stream-wide
  // deadline — the mechanism `runProjectorWorkflowBody` (projector-workflow.ts)
  // relies on to tell a true liveness breach apart from a real projection bug.
  describe("liveness: idle-timeout as a first-class silence terminal", () => {
    test("a fully silent source trips StreamIdleTimeoutError after idleTimeoutMs", async () => {
      async function* silent(): AsyncIterable<Msg> {
        await new Promise<never>(() => {}); // mimics a dead executor: never yields
      }
      const stream = createProjectorChunkStreamFromMessages({
        messages: silent(),
        runId: "run_1",
        fenceToken: "fence_a",
        idleTimeoutMs: 15,
      });

      let caught: unknown;
      try {
        await readAll(stream);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(StreamIdleTimeoutError);
      expect((caught as StreamIdleTimeoutError).idleTimeoutMs).toBe(15);
      expect((caught as Error).message).toContain(
        "producer produced no output before timeout",
      );
    });

    test("any event resets the idle window — gaps under idleTimeoutMs never trip it, even though the total elapsed time exceeds it", async () => {
      // 3 gaps of 20ms (60ms total) against a 50ms idle window: a single
      // stream-wide deadline would have errored at 50ms; a per-message
      // rolling window (the actual implementation) never sees a gap wider
      // than 20ms and completes cleanly. The middle chunk stands in for a
      // future T5/T6 `data-liveness` heartbeat — any chunk type resets the
      // window identically, there is no special-casing by type.
      async function* trickle(): AsyncIterable<Msg> {
        await sleep(20);
        yield msg("run_1:fence_a:1", { p: { type: "start" } });
        await sleep(20);
        yield msg("run_1:fence_a:2", {
          p: { type: "data-liveness", data: {} },
        });
        await sleep(20);
        yield msg("run_1:fence_a:3", { p: { type: "finish" } });
        yield msg("run_1:fence_a:done:3", { done: true, finalSeq: 3 });
      }
      const stream = createProjectorChunkStreamFromMessages({
        messages: trickle(),
        runId: "run_1",
        fenceToken: "fence_a",
        idleTimeoutMs: 50,
      });

      const out = await readAll(stream);
      expect(out.map((c) => c.type)).toEqual([
        "start",
        "data-liveness",
        "finish",
      ]);
    });

    test("omitting idleTimeoutMs disables idle enforcement (live-tail semantics)", async () => {
      // No idle timer at all when idleTimeoutMs is omitted — the UI live-tail
      // (nats-stream-buffer.ts) relies on exactly this to stay open across
      // silent gaps that span whole runs.
      async function* delayedFinish(): AsyncIterable<Msg> {
        await sleep(30);
        yield msg("run_1:fence_a:1", { p: { type: "finish" } });
        yield msg("run_1:fence_a:done:1", { done: true, finalSeq: 1 });
      }
      const stream = createProjectorChunkStreamFromMessages({
        messages: delayedFinish(),
        runId: "run_1",
        fenceToken: "fence_a",
      });

      expect((await readAll(stream)).map((c) => c.type)).toEqual(["finish"]);
    });
  });
});
