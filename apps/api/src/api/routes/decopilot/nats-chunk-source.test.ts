// apps/api/src/api/routes/decopilot/nats-chunk-source.test.ts
import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import {
  natsChunkSource,
  fenceFilter,
  assertContiguousAndDedup,
  projectorChunkStream,
} from "./nats-chunk-source";
import {
  concat,
  decodeStream,
  reassembleFragments,
  type DecodedEvent,
  type RawMsg,
} from "@decocms/harness/run-stream-codec";

const enc = new TextEncoder();

function raw(
  msgId: string | null,
  body: string,
  headers?: Record<string, string>,
): RawMsg {
  const all: Record<string, string> = {
    ...(msgId !== null ? { "Nats-Msg-Id": msgId } : {}),
    ...headers,
  };
  return {
    subject: "decopilot.stream.run_1",
    data: enc.encode(body),
    headers: { get: (n) => all[n] },
  };
}
function rawJson(
  msgId: string | null,
  payload: unknown,
  headers?: Record<string, string>,
): RawMsg {
  return raw(msgId, JSON.stringify(payload), headers);
}
async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const out: T[] = [];
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

function fragments(
  seqMsgIdBase: string | null,
  body: string,
  parts: number,
): RawMsg[] {
  const bytes = enc.encode(body);
  const slice = Math.ceil(bytes.length / parts);
  const out: RawMsg[] = [];
  for (let i = 0; i < parts; i++) {
    const m = raw(
      seqMsgIdBase === null ? null : `${seqMsgIdBase}:frag:${i}`,
      "",
      {
        [FRAG_TOTAL_HEADER_NAME]: String(parts),
        [FRAG_INDEX_HEADER_NAME]: String(i),
      },
    );
    m.data = bytes.slice(i * slice, (i + 1) * slice);
    out.push(m);
  }
  return out;
}

async function pipeThrough<I, O>(
  input: RawMsg[],
  t: TransformStream<I, O>,
): Promise<O[]> {
  const src = natsChunkSource({ messages: input as unknown as RawMsg[] });
  return readAll((src as ReadableStream<I>).pipeThrough(t));
}

const FRAG_TOTAL_HEADER_NAME = "Dp-Frag-Total";
const FRAG_INDEX_HEADER_NAME = "Dp-Frag-Idx";

describe("reassembleFragments", () => {
  test("passes a non-fragment message through unchanged", async () => {
    const input = [rawJson("run_1:fence_a:1", { p: { type: "start" } })];
    const out = await pipeThrough<RawMsg, RawMsg>(input, reassembleFragments());
    expect(out.map((m) => new TextDecoder().decode(m.data))).toEqual([
      JSON.stringify({ p: { type: "start" } }),
    ]);
  });

  test("stitches an in-order fragment set into one message", async () => {
    const body = JSON.stringify({
      p: { type: "text-delta", id: "t", delta: "hello-world" },
    });
    const out = await pipeThrough<RawMsg, RawMsg>(
      fragments("run_1:fence_a:1", body, 3),
      reassembleFragments(),
    );
    expect(out.map((m) => new TextDecoder().decode(m.data))).toEqual([body]);
  });

  test("keeps consecutive same-total fragment sets separate", async () => {
    const a = JSON.stringify({ p: "A".repeat(40) });
    const b = JSON.stringify({ p: "B".repeat(40) });
    const out = await pipeThrough<RawMsg, RawMsg>(
      [
        ...fragments("run_1:fence_a:1", a, 3),
        ...fragments("run_1:fence_a:2", b, 3),
      ],
      reassembleFragments(),
    );
    expect(out.map((m) => new TextDecoder().decode(m.data))).toEqual([a, b]);
  });

  test("drops a stray mid-sequence fragment (no index-0 anchor)", async () => {
    const stray = fragments(
      "run_1:fence_a:1",
      JSON.stringify({ p: "X".repeat(40) }),
      3,
    ).slice(1); // idx 1,2
    const good = JSON.stringify({ p: "good" });
    const out = await pipeThrough<RawMsg, RawMsg>(
      [...stray, ...fragments("run_1:fence_a:2", good, 3)],
      reassembleFragments(),
    );
    expect(out.map((m) => new TextDecoder().decode(m.data))).toEqual([good]);
  });

  test("drops an incomplete set (lost middle fragment) and recovers on the next", async () => {
    const lost = fragments(
      "run_1:fence_a:1",
      JSON.stringify({ p: "Y".repeat(40) }),
      3,
    );
    const recovered = JSON.stringify({ p: "recovered" });
    const out = await pipeThrough<RawMsg, RawMsg>(
      [lost[0]!, lost[2]!, ...fragments("run_1:fence_a:2", recovered, 3)], // idx 1 missing
      reassembleFragments(),
    );
    expect(out.map((m) => new TextDecoder().decode(m.data))).toEqual([
      recovered,
    ]);
  });
});

describe("concat", () => {
  test("joins byte slices in order", () => {
    const merged = concat([
      enc.encode("ab"),
      enc.encode("c"),
      enc.encode("de"),
    ]);
    expect(new TextDecoder().decode(merged)).toBe("abcde");
  });
});

async function unwrapAll(input: RawMsg[]): Promise<DecodedEvent[]> {
  return pipeThrough<RawMsg, DecodedEvent>(input, decodeStream());
}

describe("decodeStream", () => {
  test("classifies a fenced chunk with seq + fence from the msgId", async () => {
    const [ev] = await unwrapAll([
      rawJson("run_1:fence_a:2", {
        p: { type: "text-delta", id: "t", delta: "x" },
      }),
    ]);
    expect(ev).toEqual({
      kind: "chunk",
      seq: 2,
      runId: "run_1",
      fenceToken: "fence_a",
      chunk: { type: "text-delta", id: "t", delta: "x" },
    });
  });

  test("classifies a chunk with no msgId (tail fragment) with null seq/fence", async () => {
    const [ev] = await unwrapAll([rawJson(null, { p: "chunk-1" })]);
    expect(ev).toEqual({
      kind: "chunk",
      seq: null,
      runId: null,
      fenceToken: null,
      chunk: "chunk-1" as unknown as UIMessageChunk,
    });
  });

  test("classifies a fenced done envelope", async () => {
    const [ev] = await unwrapAll([
      rawJson("run_1:fence_a:done:5", { done: true, finalSeq: 5 }),
    ]);
    expect(ev).toEqual({
      kind: "done",
      runId: "run_1",
      fenceToken: "fence_a",
      envelopeFinalSeq: 5,
      msgIdFinalSeq: 5,
    });
  });

  test("classifies an unfenced done sentinel with null fence + null finalSeq", async () => {
    const [ev] = await unwrapAll([rawJson(null, { done: true })]);
    expect(ev).toEqual({
      kind: "done",
      runId: null,
      fenceToken: null,
      envelopeFinalSeq: null,
      msgIdFinalSeq: null,
    });
  });

  test("skips a message with an unrecognized msgId format", async () => {
    // An unknown msgId format (e.g. a leftover marker from a removed protocol
    // feature) must be silently skipped rather than misclassified.
    const out = await unwrapAll([
      rawJson("run_1:fence_a:unknown:7", { some: "payload" }),
    ]);
    expect(out).toEqual([]);
  });

  test("skips malformed JSON and a chunk-shaped msgId lacking a payload `p`", async () => {
    const out = await unwrapAll([
      rawJson("run_1:fence_a:1", { p: { type: "start" } }),
      raw("run_1:fence_a:2", "not-json{{{"),
      rawJson("run_1:fence_a:3", { notP: true }),
      rawJson("run_1:fence_a:4", { p: { type: "finish" } }),
    ]);
    expect(
      out.map((e) =>
        e.kind === "chunk" ? (e.chunk as { type: string }).type : e.kind,
      ),
    ).toEqual(["start", "finish"]);
  });
});

async function pipe2(
  input: RawMsg[],
  runId: string,
  fence: string,
): Promise<DecodedEvent[]> {
  const src = natsChunkSource({ messages: input });
  return readAll(
    src
      .pipeThrough(reassembleFragments())
      .pipeThrough(decodeStream())
      .pipeThrough(fenceFilter(runId, fence)),
  );
}

describe("fenceFilter", () => {
  test("keeps matching run+fence, drops other fence, drops unfenced done", async () => {
    const out = await pipe2(
      [
        rawJson("run_1:fence_a:1", { p: { type: "start" } }),
        rawJson("run_1:other:1", { p: { type: "start" } }), // wrong fence
        rawJson(null, { done: true }), // unfenced sentinel
        rawJson("run_1:fence_a:done:1", { done: true, finalSeq: 1 }),
      ],
      "run_1",
      "fence_a",
    );
    expect(out.map((e) => e.kind)).toEqual(["chunk", "done"]);
    expect(out[1]).toMatchObject({
      kind: "done",
      fenceToken: "fence_a",
      envelopeFinalSeq: 1,
    });
  });
});

async function pipe3(
  input: RawMsg[],
  runId: string,
  fence: string,
): Promise<DecodedEvent[]> {
  const src = natsChunkSource({ messages: input });
  return readAll(
    src
      .pipeThrough(reassembleFragments())
      .pipeThrough(decodeStream())
      .pipeThrough(fenceFilter(runId, fence))
      .pipeThrough(assertContiguousAndDedup()),
  );
}

describe("assertContiguousAndDedup", () => {
  test("passes in-order chunks, dedups a replay, passes done", async () => {
    const out = await pipe3(
      [
        rawJson("run_1:fence_a:1", { p: { type: "start" } }),
        rawJson("run_1:fence_a:1", { p: { type: "start" } }), // replay → dedup
        rawJson("run_1:fence_a:2", { p: { type: "finish" } }),
        rawJson("run_1:fence_a:done:2", { done: true, finalSeq: 2 }),
      ],
      "run_1",
      "fence_a",
    );
    expect(out.map((e) => e.kind)).toEqual(["chunk", "chunk", "done"]);
  });

  test("errors on a forward gap", async () => {
    await expect(
      pipe3(
        [
          rawJson("run_1:fence_a:1", { p: { type: "start" } }),
          rawJson("run_1:fence_a:3", { p: { type: "finish" } }),
        ],
        "run_1",
        "fence_a",
      ),
    ).rejects.toThrow("missing seq 2");
  });
});

function projectorPipeline(
  input: RawMsg[],
  runId: string,
  fence: string,
  onCancel?: () => void,
) {
  const src = natsChunkSource({ messages: input, onCancel });
  const events = src
    .pipeThrough(reassembleFragments())
    .pipeThrough(decodeStream())
    .pipeThrough(fenceFilter(runId, fence))
    .pipeThrough(assertContiguousAndDedup());
  return projectorChunkStream(events);
}

describe("projectorChunkStream", () => {
  test("closes on a matching fenced done and emits the chunks before it", async () => {
    const out = await readAll(
      projectorPipeline(
        [
          rawJson("run_1:fence_a:1", { p: { type: "start" } }),
          rawJson("run_1:fence_a:2", {
            p: { type: "text-delta", id: "t", delta: "hi" },
          }),
          rawJson("run_1:fence_a:done:2", { done: true, finalSeq: 2 }),
          rawJson("run_1:fence_a:3", { p: { type: "finish" } }),
        ],
        "run_1",
        "fence_a",
      ),
    );
    expect(out.map((c) => c.type)).toEqual(["start", "text-delta"]);
  });

  test("does NOT close on the AI-SDK finish chunk; keeps reading to the fenced done", async () => {
    // Background title generation emits its transient `data-title-result` chunk
    // AFTER the assistant `finish` chunk on fast runs. The projector must run to
    // the fenced `done` (whose finalSeq covers it) rather than closing at
    // `finish`, or the title is dropped and the thread stays on "New chat".
    const out = await readAll(
      projectorPipeline(
        [
          rawJson("run_1:fence_a:1", { p: { type: "start" } }),
          rawJson("run_1:fence_a:2", {
            p: { type: "finish", finishReason: "stop" },
          }),
          rawJson("run_1:fence_a:3", {
            p: { type: "data-title-result", data: { title: "Late title" } },
          }),
          rawJson("run_1:fence_a:done:3", { done: true, finalSeq: 3 }),
        ],
        "run_1",
        "fence_a",
      ),
    );
    expect(out.map((c) => c.type)).toEqual([
      "start",
      "finish",
      "data-title-result",
    ]);
  });

  test("errors on a tail gap exposed by finalSeq", async () => {
    await expect(
      readAll(
        projectorPipeline(
          [
            rawJson("run_1:fence_a:1", { p: { type: "start" } }),
            rawJson("run_1:fence_a:2", {
              p: { type: "text-delta", id: "t", delta: "x" },
            }),
            rawJson("run_1:fence_a:done:5", { done: true, finalSeq: 5 }),
          ],
          "run_1",
          "fence_a",
        ),
      ),
    ).rejects.toThrow("missing seq 3");
  });

  test("cancels the source (→ onCancel/sub.stop) via the cascade when it closes on a terminal", async () => {
    // Infinite source: yields the terminal then blocks forever, mimicking a live
    // NATS subscription. onCancel can ONLY fire if projectorChunkStream's
    // reader.cancel() cascades up the pipeThrough chain to natsChunkSource —
    // the real production mechanism (verified: Bun cascades through 4 stages).
    async function* infiniteAfter(msgs: RawMsg[]): AsyncIterable<RawMsg> {
      for (const m of msgs) yield m;
      await new Promise<void>(() => {}); // block forever
    }
    let cancelled = false;
    const src = natsChunkSource({
      messages: infiniteAfter([
        rawJson("run_1:fence_a:1", { p: { type: "finish" } }),
        rawJson("run_1:fence_a:done:1", { done: true, finalSeq: 1 }),
      ]),
      onCancel: () => {
        cancelled = true;
      },
    });
    const events = src
      .pipeThrough(reassembleFragments())
      .pipeThrough(decodeStream())
      .pipeThrough(fenceFilter("run_1", "fence_a"))
      .pipeThrough(assertContiguousAndDedup());
    const out = await readAll(projectorChunkStream(events));
    expect(out.map((c) => c.type)).toEqual(["finish"]);
    // let the propagated cancel settle
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toBe(true);
  });

  test("cancels the source (→ onCancel/sub.stop) when it errors on a gap before done", async () => {
    // The ERROR exits must stop the subscription too, not just the success
    // exits — otherwise a projection error leaks the live NATS sub. Infinite
    // source so onCancel can ONLY fire via the reader.cancel() cascade up the
    // pipeThrough chain, never via natural exhaustion. The done's finalSeq (5)
    // exceeds the last delivered chunk seq (2) → the gap-before-done error exit.
    async function* infiniteAfter(msgs: RawMsg[]): AsyncIterable<RawMsg> {
      for (const m of msgs) yield m;
      await new Promise<void>(() => {}); // block forever
    }
    let cancelled = false;
    const src = natsChunkSource({
      messages: infiniteAfter([
        rawJson("run_1:fence_a:1", { p: { type: "start" } }),
        rawJson("run_1:fence_a:2", {
          p: { type: "text-delta", id: "t", delta: "x" },
        }),
        rawJson("run_1:fence_a:done:5", { done: true, finalSeq: 5 }),
      ]),
      onCancel: () => {
        cancelled = true;
      },
    });
    const events = src
      .pipeThrough(reassembleFragments())
      .pipeThrough(decodeStream())
      .pipeThrough(fenceFilter("run_1", "fence_a"))
      .pipeThrough(assertContiguousAndDedup());
    await expect(readAll(projectorChunkStream(events))).rejects.toThrow(
      "missing seq 3",
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toBe(true);
  });
});

describe("natsChunkSource", () => {
  test("passes through raw messages and closes when the iterable ends", async () => {
    const src = natsChunkSource({
      messages: [rawJson("run_1:fence_a:1", { p: { type: "start" } })],
    });
    const out = await readAll(src);
    expect(out.map((m) => new TextDecoder().decode(m.data))).toEqual([
      JSON.stringify({ p: { type: "start" } }),
    ]);
  });

  test("calls onCancel when the stream is cancelled", async () => {
    let cancelled = false;
    async function* never(): AsyncIterable<RawMsg> {
      // yields one then awaits forever
      yield rawJson("run_1:fence_a:1", { p: { type: "start" } });
      await new Promise(() => {});
    }
    const src = natsChunkSource({
      messages: never(),
      onCancel: () => {
        cancelled = true;
      },
    });
    const reader = src.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  test("errors when no output is produced before the idle timeout", async () => {
    async function* silent(): AsyncIterable<RawMsg> {
      await new Promise(() => {}); // never yields
    }
    const src = natsChunkSource({ messages: silent(), idleTimeoutMs: 10 });
    await expect(readAll(src)).rejects.toThrow(
      "producer produced no output before timeout",
    );
  });
});
