/**
 * Unit tests for the daemon-side chunk relay.
 *
 * All tests drive the relay with in-memory SSE bodies and stub `post`
 * implementations — no real HTTP. Stubs mirror a real fetch: they read the
 * NDJSON body stream and reject when that stream errors, because a real
 * streaming upload dies when its request body errors.
 */
import { describe, expect, it } from "bun:test";
import type { DispatchSSEEvent } from "../links/protocol";
import {
  RELAY_BUFFER_MAX_BYTES,
  type RelayLine,
  relayLineSchema,
} from "../links/protocol/relay";
import {
  type RelayPostResult,
  relayDispatchSSEAsChunkStream,
} from "./chunk-relay";

const enc = new TextEncoder();

function sseFrame(event: unknown): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/** A closed SSE body containing the given events. */
function sseBody(events: unknown[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) controller.enqueue(sseFrame(ev));
      controller.close();
    },
  });
}

/** An SSE body the test pushes into incrementally. */
function pushableSSEBody(): {
  body: ReadableStream<Uint8Array>;
  push: (event: unknown) => void;
  close: () => void;
  cancelled: () => boolean;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    body,
    push: (event) => controller.enqueue(sseFrame(event)),
    close: () => controller.close(),
    cancelled: () => cancelled,
  };
}

/** Read a full NDJSON body and parse+validate every line. */
async function readAllLines(
  body: ReadableStream<Uint8Array> | string,
): Promise<RelayLine[]> {
  const text =
    typeof body === "string" ? body : await new Response(body).text();
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => relayLineSchema.parse(JSON.parse(l)));
}

/** Incremental NDJSON line iterator over a body stream. */
async function* ndjsonLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RelayLine> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length > 0) yield relayLineSchema.parse(JSON.parse(line));
        nl = buf.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const CHUNK_A: DispatchSSEEvent = {
  type: "ui-message-chunk",
  chunk: { type: "text-delta", id: "t1", delta: "hello" },
};
const CHUNK_B: DispatchSSEEvent = {
  type: "ui-message-chunk",
  chunk: { type: "text-delta", id: "t1", delta: " world" },
};
const DONE: DispatchSSEEvent = { type: "done" };

describe("relayDispatchSSEAsChunkStream", () => {
  it("relays SSE events as seq-numbered NDJSON lines ending in done", async () => {
    const posts: { fromSeq: number; lines: RelayLine[] }[] = [];

    await relayDispatchSSEAsChunkStream({
      dispatchBody: sseBody([CHUNK_A, CHUNK_B, DONE]),
      runId: "run_1",
      post: async (body, fromSeq): Promise<RelayPostResult> => {
        const lines = await readAllLines(body);
        posts.push({ fromSeq, lines });
        return { ok: true, lastSeq: lines.at(-1)?.seq ?? 0 };
      },
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]!.fromSeq).toBe(1);
    expect(posts[0]!.lines).toEqual([
      { seq: 1, event: CHUNK_A },
      { seq: 2, event: CHUNK_B },
      { seq: 3, event: DONE },
    ]);
  });

  it("forwards error events as relay lines (not thrown)", async () => {
    const posts: RelayLine[][] = [];
    const errorEvent: DispatchSSEEvent = {
      type: "error",
      code: "harness_crashed",
      message: "boom",
    };

    await relayDispatchSSEAsChunkStream({
      dispatchBody: sseBody([CHUNK_A, errorEvent, DONE]),
      runId: "run_1",
      post: async (body): Promise<RelayPostResult> => {
        const lines = await readAllLines(body);
        posts.push(lines);
        return { ok: true, lastSeq: lines.at(-1)?.seq ?? 0 };
      },
    });

    expect(posts[0]).toEqual([
      { seq: 1, event: CHUNK_A },
      { seq: 2, event: errorEvent },
      { seq: 3, event: DONE },
    ]);
  });

  it("synthesizes a terminal done when the sandbox stream ends without one", async () => {
    const posts: RelayLine[][] = [];

    await relayDispatchSSEAsChunkStream({
      dispatchBody: sseBody([CHUNK_A, CHUNK_B]),
      runId: "run_1",
      post: async (body): Promise<RelayPostResult> => {
        const lines = await readAllLines(body);
        posts.push(lines);
        return { ok: true, lastSeq: lines.at(-1)?.seq ?? 0 };
      },
    });

    expect(posts[0]).toEqual([
      { seq: 1, event: CHUNK_A },
      { seq: 2, event: CHUNK_B },
      { seq: 3, event: DONE },
    ]);
  });

  it("opens the POST immediately and streams lines as events arrive (does not wait for the source to end)", async () => {
    const sse = pushableSSEBody();
    const firstLineSeen = Promise.withResolvers<RelayLine>();

    const relayPromise = relayDispatchSSEAsChunkStream({
      dispatchBody: sse.body,
      runId: "run_1",
      post: async (body): Promise<RelayPostResult> => {
        if (typeof body === "string") throw new Error("expected a stream");
        let last = 0;
        for await (const line of ndjsonLines(body)) {
          last = line.seq;
          firstLineSeen.resolve(line);
        }
        return { ok: true, lastSeq: last };
      },
    });

    // Push one chunk while the source is still open — the POST body must
    // surface it before the run ends.
    sse.push(CHUNK_A);
    const first = await firstLineSeen.promise;
    expect(first).toEqual({ seq: 1, event: CHUNK_A });

    sse.push(DONE);
    sse.close();
    await relayPromise;
  });

  it("reconnects after a dropped POST and resends the full buffered prefix", async () => {
    const sse = pushableSSEBody();
    const attempts: { fromSeq: number; lines: RelayLine[] }[] = [];
    const firstAttemptGotLine = Promise.withResolvers<void>();
    let attempt = 0;

    const relayPromise = relayDispatchSSEAsChunkStream({
      dispatchBody: sse.body,
      runId: "run_1",
      post: async (body, fromSeq): Promise<RelayPostResult> => {
        if (typeof body === "string") throw new Error("expected a stream");
        attempt += 1;
        const mine = attempt;
        const record = { fromSeq, lines: [] as RelayLine[] };
        attempts.push(record);
        for await (const line of ndjsonLines(body)) {
          record.lines.push(line);
          if (mine === 1) {
            // Simulate a connection drop mid-upload after the first line.
            firstAttemptGotLine.resolve();
            throw new Error("socket hang up");
          }
        }
        return { ok: true, lastSeq: record.lines.at(-1)?.seq ?? 0 };
      },
    });

    sse.push(CHUNK_A);
    await firstAttemptGotLine.promise;
    // Lines produced while the relay is disconnected must be buffered…
    sse.push(CHUNK_B);
    sse.push(DONE);
    sse.close();

    await relayPromise;

    // …and the reconnect attempt must resend the WHOLE prefix from seq 1.
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.fromSeq).toBe(1);
    expect(attempts[1]!.fromSeq).toBe(1);
    expect(attempts[1]!.lines).toEqual([
      { seq: 1, event: CHUNK_A },
      { seq: 2, event: CHUNK_B },
      { seq: 3, event: DONE },
    ]);
  });

  it("retries when the cluster acks fewer lines than the terminal seq", async () => {
    const attempts: RelayLine[][] = [];

    await relayDispatchSSEAsChunkStream({
      dispatchBody: sseBody([CHUNK_A, DONE]),
      runId: "run_1",
      post: async (body): Promise<RelayPostResult> => {
        const lines = await readAllLines(body);
        attempts.push(lines);
        // First response under-acks (server lost the tail) → must retry.
        if (attempts.length === 1) return { ok: true, lastSeq: 1 };
        return { ok: true, lastSeq: lines.at(-1)?.seq ?? 0 };
      },
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.map((l) => l.seq)).toEqual([1, 2]);
  });

  it("does not retry post failures carrying a 4xx status (fence loss is permanent)", async () => {
    let postCalls = 0;

    await expect(
      relayDispatchSSEAsChunkStream({
        dispatchBody: sseBody([CHUNK_A, DONE]),
        runId: "run_1",
        post: async (body): Promise<RelayPostResult> => {
          postCalls += 1;
          await readAllLines(body);
          const err = new Error("relay failed (409)");
          (err as { status?: number }).status = 409;
          throw err;
        },
      }),
    ).rejects.toThrow("relay failed (409)");

    expect(postCalls).toBe(1);
  });

  it("throws when the relay buffer exceeds RELAY_BUFFER_MAX_BYTES", async () => {
    // Enough 1 MiB deltas to push the serialized lines past the cap.
    const deltaBytes = 1024 * 1024;
    const overflowCount = Math.ceil(RELAY_BUFFER_MAX_BYTES / deltaBytes) + 1;
    const bigDelta = "x".repeat(deltaBytes);
    const events: unknown[] = [];
    for (let i = 0; i < overflowCount; i++) {
      events.push({
        type: "ui-message-chunk",
        chunk: { type: "text-delta", id: "t1", delta: bigDelta },
      });
    }
    events.push(DONE);

    // The post stub reads the body like a real upload: when the relay fails,
    // the body errors and the read rejects.
    await expect(
      relayDispatchSSEAsChunkStream({
        dispatchBody: sseBody(events),
        runId: "run_overflow",
        post: async (body): Promise<RelayPostResult> => {
          const lines = await readAllLines(body);
          return { ok: true, lastSeq: lines.at(-1)?.seq ?? 0 };
        },
      }),
    ).rejects.toThrow(/run_overflow.*relay buffer exceeded/);
  });

  it("aborts cleanly via signal: rejects with the reason and cancels the source", async () => {
    const sse = pushableSSEBody();
    const firstLineSeen = Promise.withResolvers<void>();
    const ac = new AbortController();

    const relayPromise = relayDispatchSSEAsChunkStream({
      dispatchBody: sse.body,
      runId: "run_1",
      signal: ac.signal,
      post: async (body): Promise<RelayPostResult> => {
        if (typeof body === "string") throw new Error("expected a stream");
        let last = 0;
        for await (const line of ndjsonLines(body)) {
          last = line.seq;
          firstLineSeen.resolve();
        }
        return { ok: true, lastSeq: last };
      },
    });

    sse.push(CHUNK_A);
    await firstLineSeen.promise;
    ac.abort(new Error("run cancelled by cluster"));

    await expect(relayPromise).rejects.toThrow("run cancelled by cluster");
    expect(sse.cancelled()).toBe(true);
  });
});
