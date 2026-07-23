/**
 * Unit tests for the daemon-side chunk relay.
 *
 * All tests drive the relay with in-memory SSE bodies and stub `post`
 * implementations — no real HTTP. Stubs mirror a real fetch: they read the
 * NDJSON body stream and reject when that stream errors, because a real
 * streaming upload dies when its request body errors.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DispatchSSEEvent } from "../links/protocol";
import { type RelayLine, relayLineSchema } from "../links/protocol/relay";
import {
  type RelayPostResult,
  relayDispatchSSEAsChunkStream,
} from "./chunk-relay";
import { openOutbox, type Outbox } from "./outbox";

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

  it("drops the durably-published prefix from the outbox as the post confirms each seq", async () => {
    // Incremental ackSeq truncation: when the post reports a line as durably
    // published (JetStream PubAck), the relay drops it from the outbox so the
    // buffer stays bounded to the in-flight window instead of the whole run.
    // Pre-fix the relay passed no confirm callback, so every line lingered until
    // terminal truncation and a long run could blow MAX_OUTBOX_BYTES.
    const outbox = openOutbox({ path: ":memory:" });
    let retainedAfterConfirmingSeq1: number[] | null = null;

    await relayDispatchSSEAsChunkStream({
      dispatchBody: sseBody([CHUNK_A, CHUNK_B, DONE]),
      runId: "run_1",
      fenceToken: "fence_1",
      outbox,
      post: async (
        body,
        _fromSeq,
        onDurablyPublished,
      ): Promise<RelayPostResult> => {
        if (typeof body === "string") throw new Error("expected a stream");
        let last = 0;
        for await (const line of ndjsonLines(body)) {
          last = line.seq;
          if (line.seq === 1) {
            onDurablyPublished?.(1);
            retainedAfterConfirmingSeq1 = outbox
              .replay({ runId: "run_1", fenceToken: "fence_1", fromSeq: 1 })
              .map((r) => r.wireSeq);
          }
        }
        return { ok: true, lastSeq: last };
      },
    });

    expect(retainedAfterConfirmingSeq1).not.toBeNull();
    expect(retainedAfterConfirmingSeq1).not.toContain(1);
    outbox.close();
  });

  it("writes a newline heartbeat into the POST body during idle gaps (defeats a CDN idle timeout)", async () => {
    const sse = pushableSSEBody();
    const heartbeatSeen = Promise.withResolvers<void>();
    const realLines: RelayLine[] = [];

    const relayPromise = relayDispatchSSEAsChunkStream({
      dispatchBody: sse.body,
      runId: "run_hb",
      // Tiny interval so the idle gap below trips a heartbeat deterministically.
      heartbeatMs: 5,
      post: async (body): Promise<RelayPostResult> => {
        if (typeof body === "string") throw new Error("expected a stream");
        const reader = body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let last = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl = buf.indexOf("\n");
          while (nl !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.length === 0) {
              // A bare "\n" = the keepalive heartbeat (a blank NDJSON line).
              heartbeatSeen.resolve();
            } else {
              const parsed = relayLineSchema.parse(JSON.parse(line));
              realLines.push(parsed);
              last = parsed.seq;
            }
            nl = buf.indexOf("\n");
          }
        }
        return { ok: true, lastSeq: last };
      },
    });

    // First real line, then stay idle (source open, no events) so the relay
    // body must emit heartbeat newlines to keep bytes flowing.
    sse.push(CHUNK_A);
    await heartbeatSeen.promise;
    sse.push(DONE);
    sse.close();
    await relayPromise;

    // Heartbeats are transient wire bytes: they never become relay lines, so
    // seq numbering is untouched.
    expect(realLines).toEqual([
      { seq: 1, event: CHUNK_A },
      { seq: 2, event: DONE },
    ]);
  }, 2000);

  it("injects a seq-numbered data-liveness relay line during a silent dispatch gap (T6 liveness heartbeat)", async () => {
    // Unlike the newline keepalive above, this heartbeat is a REAL relay
    // line: it must consume the relay's own seq counter (the same one every
    // ui-message-chunk/error/done event uses) so it rides the identical
    // dedup/outbox contract and can reset the projector's idle window.
    const sse = pushableSSEBody();
    const heartbeatSeen = Promise.withResolvers<RelayLine>();
    const lines: RelayLine[] = [];

    const relayPromise = relayDispatchSSEAsChunkStream({
      dispatchBody: sse.body,
      runId: "run_hb_live",
      // Tiny interval so the idle gap below trips a liveness heartbeat
      // deterministically without waiting the real 30s production default.
      livenessHeartbeatMs: 5,
      post: async (body): Promise<RelayPostResult> => {
        if (typeof body === "string") throw new Error("expected a stream");
        for await (const line of ndjsonLines(body)) {
          lines.push(line);
          const chunk =
            line.event.type === "ui-message-chunk"
              ? (line.event.chunk as { type?: string } | undefined)
              : undefined;
          if (chunk?.type === "data-liveness") heartbeatSeen.resolve(line);
        }
        return { ok: true, lastSeq: lines.at(-1)?.seq ?? 0 };
      },
    });

    // One real chunk, then stay idle so the pump's silence trips a
    // liveness heartbeat.
    sse.push(CHUNK_A);
    const heartbeatLine = await heartbeatSeen.promise;
    // The heartbeat consumed the NEXT real seq after CHUNK_A (seq 1) — not a
    // side channel and not seq 1 again.
    expect(heartbeatLine.seq).toBe(2);
    expect(heartbeatLine.event).toEqual({
      type: "ui-message-chunk",
      chunk: {
        type: "data-liveness",
        data: { t: expect.any(Number) },
        transient: true,
      },
    });

    sse.push(DONE);
    sse.close();
    await relayPromise;

    // Seqs are strictly increasing and the pump stops heartbeating once the
    // dispatch ends: `done` is the terminal line, not followed by more
    // heartbeats.
    const seqs = lines.map((l) => l.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(lines.at(-1)!.event).toEqual(DONE);
  }, 2000);

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

  it("retries a network drop (no status) up to the configured maxAttempts, then gives up", async () => {
    // ECONNRESET-style failure: no `.status` → retriable. The widened retry
    // budget is what lets a transient cluster/edge reset recover; here we use a
    // small override and assert the relay honors it exactly before failing.
    let postCalls = 0;

    await expect(
      relayDispatchSSEAsChunkStream({
        dispatchBody: sseBody([CHUNK_A, DONE]),
        runId: "run_econnreset",
        retry: { maxAttempts: 4, minTimeout: 1, maxTimeout: 2, jitter: 0 },
        post: async (body): Promise<RelayPostResult> => {
          postCalls += 1;
          await readAllLines(body);
          throw new Error("The socket connection was closed unexpectedly");
        },
      }),
    ).rejects.toThrow("socket connection was closed");

    expect(postCalls).toBe(4);
  });

  it("still overflows loudly when the post never confirms durable progress (stalled-publisher backstop)", async () => {
    // A post that reads the body but never calls onDurablyPublished → the relay
    // cannot drop the prefix, so a run larger than the cap fills the outbox and
    // fails loudly. Use a small explicit cap so the test stays fast.
    const cap = 4 * 1024 * 1024; // 4 MiB
    const outbox = openOutbox({ path: ":memory:", maxBytes: cap });
    const deltaBytes = 1024 * 1024;
    const overflowCount = Math.ceil(cap / deltaBytes) + 1;
    const bigDelta = "x".repeat(deltaBytes);
    const events: unknown[] = [];
    for (let i = 0; i < overflowCount; i++) {
      events.push({
        type: "ui-message-chunk",
        chunk: { type: "text-delta", id: "t1", delta: bigDelta },
      });
    }
    events.push(DONE);

    await expect(
      relayDispatchSSEAsChunkStream({
        dispatchBody: sseBody(events),
        runId: "run_overflow",
        fenceToken: "fence_1",
        outbox,
        post: async (body): Promise<RelayPostResult> => {
          const lines = await readAllLines(body);
          return { ok: true, lastSeq: lines.at(-1)?.seq ?? 0 };
        },
      }),
    ).rejects.toThrow(/run_overflow.*outbox exceeded MAX_OUTBOX_BYTES/);
    outbox.close();
  });

  it("drops the run's rows from the outbox when the relay FAILS (no leak)", async () => {
    // `truncateRun` used to fire only on terminal SUCCESS, so a failed/aborted
    // run leaked its rows forever — dead runs accumulated until the daemon-wide
    // MAX_OUTBOX_BYTES wedged and every new run failed. The relay must drop a
    // run's rows on EVERY terminal outcome.
    const outbox = openOutbox({ path: ":memory:" });
    await expect(
      relayDispatchSSEAsChunkStream({
        dispatchBody: sseBody([CHUNK_A, CHUNK_B, DONE]),
        runId: "run_fail",
        fenceToken: "fence_1",
        outbox,
        retry: { maxAttempts: 1, minTimeout: 1, maxTimeout: 10 },
        post: async (body): Promise<RelayPostResult> => {
          // Drain the body so the pump appends every line, THEN fail.
          await readAllLines(body);
          throw Object.assign(new Error("relay 503"), { status: 503 });
        },
      }),
    ).rejects.toThrow();

    expect(
      outbox.replay({ runId: "run_fail", fenceToken: "fence_1", fromSeq: 1 }),
    ).toEqual([]);
    outbox.close();
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

describe("relayDispatchSSEAsChunkStream + durable outbox", () => {
  let dir: string;
  let outbox: Outbox;
  const FENCE = "fence-relay";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-outbox-"));
    outbox = openOutbox({ path: join(dir, "ob.sqlite") });
  });
  afterEach(() => {
    outbox.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends every line to the injected outbox, then truncates on terminal ack", async () => {
    await relayDispatchSSEAsChunkStream({
      dispatchBody: sseBody([CHUNK_A, CHUNK_B, DONE]),
      runId: "run_ob",
      fenceToken: FENCE,
      outbox,
      post: async (body): Promise<RelayPostResult> => {
        const lines = await readAllLines(body);
        return { ok: true, lastSeq: lines.at(-1)?.seq ?? 0 };
      },
    });
    // Run was terminal-acked → truncated → nothing left to replay.
    expect(
      outbox.replay({ runId: "run_ob", fenceToken: FENCE, fromSeq: 1 }),
    ).toEqual([]);
  });

  it("truncates a terminally-failed run's rows from the durable file (no cross-restart leak)", async () => {
    const sse = pushableSSEBody();
    const crashed = Promise.withResolvers<void>();
    const relayPromise = relayDispatchSSEAsChunkStream({
      dispatchBody: sse.body,
      runId: "run_crash",
      fenceToken: FENCE,
      outbox,
      // Fast retry budget — this test asserts on-disk durability after the
      // budget is exhausted, not the (widened) production timing.
      retry: { maxAttempts: 2, minTimeout: 1, maxTimeout: 2, jitter: 0 },
      post: async (body): Promise<RelayPostResult> => {
        for await (const _line of ndjsonLines(
          body as ReadableStream<Uint8Array>,
        )) {
          crashed.resolve();
          throw new Error("socket hang up"); // never reaches terminal ack
        }
        return { ok: true, lastSeq: 0 };
      },
    }).catch(() => {}); // we expect failure after retries

    sse.push(CHUNK_A);
    await crashed.promise;
    sse.push(DONE);
    sse.close();
    await relayPromise;

    // The run terminally failed (retries exhausted), so the relay dropped its
    // rows on the way out — even from the DURABLE file. A failed run no longer
    // leaks its prefix (which used to accumulate dead runs until the daemon-wide
    // cap wedged the relay). Reopen at the same path to prove the truncation hit
    // disk. (Cross-restart resend is intentionally gone — the boot sweep would
    // clear any survivors anyway, since a run can't outlive its daemon.)
    outbox.close();
    const reopened = openOutbox({ path: join(dir, "ob.sqlite") });
    const rows = reopened.replay({
      runId: "run_crash",
      fenceToken: FENCE,
      fromSeq: 1,
    });
    expect(rows).toEqual([]);
    reopened.close();
    // Reopen the shared handle so afterEach's close() is balanced.
    outbox = openOutbox({ path: join(dir, "ob.sqlite") });
  });
});
