import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import {
  serializeChunk,
  serializeDone,
  serializeUnfencedDone,
  parseRunStreamMsgId,
  buildChunkMsgId,
  MAX_PUBLISH_BYTES,
  FRAG_INDEX_HEADER,
  FRAG_TOTAL_HEADER,
  decodeMessage,
  reassembleFragments,
  type RawMsg,
} from "./run-stream-codec";

const dec = (u: Uint8Array) => JSON.parse(new TextDecoder().decode(u));

describe("serializeChunk", () => {
  test("small chunk → one message, {p:chunk}, dedup msgId, no frag headers", () => {
    const chunk = { type: "text-delta", id: "t1", delta: "hi" };
    const [m, ...rest] = serializeChunk(chunk, {
      runId: "run_1",
      dedup: { fenceToken: "f", seq: 3 },
    });
    expect(rest).toHaveLength(0);
    expect(m.subject).toBe("decopilot.stream.run_1");
    expect(dec(m.data)).toEqual({ p: chunk });
    expect(m.msgId).toBe("run_1:f:3");
    expect(m.headers).toBeUndefined();
  });

  test("no dedup ref → no msgId (live pump path)", () => {
    const [m] = serializeChunk(
      { type: "text-delta", id: "t", delta: "x" },
      { runId: "run_1" },
    );
    expect(m.msgId).toBeUndefined();
  });

  test("payload over MAX_PUBLISH_BYTES → ordered fragments with headers + per-frag msgId", () => {
    const big = {
      type: "text-delta",
      id: "t",
      delta: "x".repeat(MAX_PUBLISH_BYTES),
    };
    const msgs = serializeChunk(big, {
      runId: "run_1",
      dedup: { fenceToken: "f", seq: 5 },
    });
    expect(msgs.length).toBeGreaterThan(1);
    msgs.forEach((m, i) => {
      expect(m.headers?.[FRAG_INDEX_HEADER]).toBe(String(i));
      expect(m.headers?.[FRAG_TOTAL_HEADER]).toBe(String(msgs.length));
      expect(m.msgId).toBe(`run_1:f:5:frag:${i}`);
    });
  });

  test("fragmentation boundary: exactly MAX_PUBLISH_BYTES encoded → 1 message", () => {
    // craft a chunk whose {p:...} JSON encodes to exactly MAX_PUBLISH_BYTES
    const overhead = new TextEncoder().encode(
      JSON.stringify({ p: { d: "" } }),
    ).length;
    const pad = "a".repeat(MAX_PUBLISH_BYTES - overhead);
    const msgs = serializeChunk(
      { d: pad },
      { runId: "r", dedup: { fenceToken: "f", seq: 1 } },
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].headers).toBeUndefined();
  });

  test("oversized (> MAX_CHUNKED_BYTES) → [] (no throw)", () => {
    const huge = { d: "z".repeat(33 * 1024 * 1024) };
    expect(serializeChunk(huge, { runId: "r" })).toEqual([]);
  });
});

describe("serializeDone", () => {
  test("fenced done carries finalSeq + done msgId", () => {
    const m = serializeDone({ runId: "run_1", fenceToken: "f", finalSeq: 9 });
    expect(dec(m.data)).toEqual({ done: true, finalSeq: 9 });
    expect(m.msgId).toBe("run_1:f:done:9");
  });
  test("unfenced done is bare {done:true} with no msgId", () => {
    const m = serializeUnfencedDone("run_1");
    expect(dec(m.data)).toEqual({ done: true });
    expect(m.msgId).toBeUndefined();
  });
});

describe("parseRunStreamMsgId", () => {
  test("chunk / fragment / done round-trip", () => {
    expect(
      parseRunStreamMsgId(
        buildChunkMsgId({ runId: "r", fenceToken: "f", seq: 4 }),
      ),
    ).toEqual({
      kind: "chunk",
      runId: "r",
      fenceToken: "f",
      seq: 4,
      fragmentIndex: null,
    });
    expect(parseRunStreamMsgId("r:f:4:frag:2")).toEqual({
      kind: "chunk",
      runId: "r",
      fenceToken: "f",
      seq: 4,
      fragmentIndex: 2,
    });
    expect(parseRunStreamMsgId("r:f:done:9")).toEqual({
      kind: "done",
      runId: "r",
      fenceToken: "f",
      finalSeq: 9,
    });
  });
  test("ckpt transition guard → null", () => {
    expect(parseRunStreamMsgId("r:f:ckpt:7")).toBeNull();
  });
});

// M1: boundary test — exactly MAX_PUBLISH_BYTES + 1 must produce 2 fragments
test("exactly MAX_PUBLISH_BYTES + 1 → 2 fragments", () => {
  const overhead = new TextEncoder().encode(
    JSON.stringify({ p: { d: "" } }),
  ).length;
  const pad = "a".repeat(MAX_PUBLISH_BYTES + 1 - overhead);
  const msgs = serializeChunk(
    { d: pad },
    { runId: "r", dedup: { fenceToken: "f", seq: 1 } },
  );
  expect(msgs).toHaveLength(2);
  expect(msgs[0].headers?.[FRAG_TOTAL_HEADER]).toBe("2");
});

// --- Decode tests ------------------------------------------------------------

const rawFrom = (m: {
  data: Uint8Array;
  subject?: string;
  headers?: Record<string, string>;
  msgId?: string;
}) => ({
  subject: m.subject ?? "decopilot.stream.r",
  data: m.data,
  headers: {
    get: (k: string) => (k === "Nats-Msg-Id" ? m.msgId : m.headers?.[k]),
  },
});

test("round-trip identity: decode(serialize(chunk)) === chunk (small)", () => {
  const chunk = {
    type: "text-delta",
    id: "t",
    delta: "hello",
  } as UIMessageChunk;
  const [m] = serializeChunk(chunk, {
    runId: "r",
    dedup: { fenceToken: "f", seq: 1 },
  });
  const ev = decodeMessage(rawFrom(m!));
  expect(ev?.kind).toBe("chunk");
  expect(ev?.kind === "chunk" && ev.chunk).toEqual(chunk);
  expect(ev?.kind === "chunk" && ev.seq).toBe(1);
});

test("fragmented chunk round-trips through reassembleFragments → decodeMessage", async () => {
  const big = {
    type: "text-delta",
    id: "t",
    delta: "x".repeat(MAX_PUBLISH_BYTES),
  } as UIMessageChunk;
  const frags = serializeChunk(big, {
    runId: "r",
    dedup: { fenceToken: "f", seq: 2 },
  });
  // pipe the fragments through reassembleFragments, decode the single output
  const reassembled: RawMsg[] = [];
  const ts = reassembleFragments();
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      reassembled.push(value);
    }
  })();
  for (const f of frags) await writer.write(rawFrom(f));
  await writer.close();
  await pump;
  expect(reassembled).toHaveLength(1);
  const ev = decodeMessage(reassembled[0]!);
  expect(ev?.kind === "chunk" && ev.chunk).toEqual(big);
});

test("decodeMessage: malformed / foreign → null", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  expect(decodeMessage(rawFrom({ data: enc("not json") }))).toBeNull();
  expect(decodeMessage(rawFrom({ data: enc('{"x":1}') }))).toBeNull(); // neither {p} nor {done}
});

test("decodeMessage: ckpt msgId on a {p} envelope → chunk with seq null", () => {
  // The envelope decides chunk-ness; the msgId only supplies seq/runId/fence.
  // A leftover ckpt msgId parses to null, so seq is null but it is still a chunk.
  const enc = (s: string) => new TextEncoder().encode(s);
  const ev = decodeMessage(
    rawFrom({
      data: enc('{"p":{"type":"text-delta","id":"t","delta":"x"}}'),
      msgId: "r:f:ckpt:7",
    }),
  );
  expect(ev?.kind).toBe("chunk");
  expect(ev?.kind === "chunk" && ev.seq).toBeNull();
});

test("done envelope decodes with finalSeq cross-check fields", () => {
  const ev = decodeMessage(
    rawFrom({
      data: new TextEncoder().encode('{"done":true,"finalSeq":9}'),
      msgId: "r:f:done:9",
    }),
  );
  expect(ev?.kind).toBe("done");
  expect(ev?.kind === "done" && ev.envelopeFinalSeq).toBe(9);
  expect(ev?.kind === "done" && ev.msgIdFinalSeq).toBe(9);
});
