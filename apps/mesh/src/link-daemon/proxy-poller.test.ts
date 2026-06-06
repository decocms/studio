/**
 * Unit tests for the proxy-poll loop (Phase C-bis S2).
 *
 * Pure logic — no real HTTP, no DB. Two surfaces are exercised:
 *
 *   1. `runOverlapScheduler` — the continuous-overlap + detached-dispatch core
 *      (landmines #5 + #2). We inject a fake `pollOnce`/`handle`/`wait` and
 *      assert (a) ≥`concurrency` polls are ALWAYS outstanding, and (b) the
 *      scheduler re-polls WITHOUT awaiting `handle` (detached).
 *
 *   2. `buildReplyBody` — the base64 NDJSON reply framing (landmine #9). We feed
 *      a fake controlHandler whose `handleStream` yields a headers event + raw
 *      bytes, then read the body stream and assert the exact frames + base64.
 */
import { describe, expect, it } from "bun:test";
import {
  buildReplyBody,
  runOverlapScheduler,
  type OverlapSchedulerDeps,
} from "./proxy-poller";
import { decodeProxyReplyFrame } from "../api/routes/decopilot/link-proxy-frames";
import type { ControlHandler, StreamEvent } from "./control-handler";
import type { RequestFrame } from "../links/link-control-types";

function reqFrame(reqId: string, path = "/_sandbox/h/events"): RequestFrame {
  return { type: "request", reqId, method: "GET", path, headers: {} };
}

/** Read an NDJSON ReadableStream fully into decoded reply frames. */
async function readFrames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const lines: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      if (line) lines.push(line);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  const tail = buf.trim();
  if (tail) lines.push(tail);
  return lines.map(decodeProxyReplyFrame);
}

describe("runOverlapScheduler — continuous overlap (landmine #5)", () => {
  it("keeps exactly `concurrency` polls outstanding at all times", async () => {
    const ac = new AbortController();
    const concurrency = 2;

    let outstanding = 0;
    let maxOutstanding = 0;
    let totalPolls = 0;
    // Resolvers for each in-flight poll so the test controls when polls return.
    const pending: Array<(f: RequestFrame | null) => void> = [];

    const pollOnce = (): Promise<RequestFrame | null> => {
      outstanding++;
      maxOutstanding = Math.max(maxOutstanding, outstanding);
      totalPolls++;
      return new Promise<RequestFrame | null>((resolve) => {
        pending.push((f) => {
          outstanding--;
          resolve(f);
        });
      });
    };

    const handle = (): void => {
      /* detached no-op */
    };

    const done = runOverlapScheduler({
      pollOnce,
      handle,
      concurrency,
      signal: ac.signal,
      wait: async () => {},
    });

    // Let both slots issue their first poll.
    await Promise.resolve();
    await Promise.resolve();
    expect(maxOutstanding).toBe(concurrency);
    expect(pending.length).toBe(concurrency);

    // Resolve one poll with a frame; the slot must re-poll, restoring overlap.
    const resolveFirst = pending.shift()!;
    resolveFirst(reqFrame("r1"));
    await Promise.resolve();
    await Promise.resolve();
    // Outstanding must be back to `concurrency` (slot re-polled after handing
    // off the frame), and the count never exceeded it.
    expect(maxOutstanding).toBe(concurrency);
    expect(totalPolls).toBe(concurrency + 1);

    // 204 (null) also re-polls immediately.
    const resolveSecond = pending.shift()!;
    resolveSecond(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(totalPolls).toBe(concurrency + 2);

    ac.abort();
    // Drain remaining pending polls so the slots can observe the abort + exit.
    for (const p of pending.splice(0)) p(null);
    await done;
  });

  it("dispatches detached: re-polls BEFORE handle resolves (landmine #2)", async () => {
    const ac = new AbortController();

    let handleResolved = false;
    let pollsAfterFrame = 0;
    let sawFrame = false;
    let releaseHandle!: () => void;
    const handleGate = new Promise<void>((r) => {
      releaseHandle = r;
    });

    const pollOnce = (): Promise<RequestFrame | null> => {
      if (sawFrame) {
        pollsAfterFrame++;
        // After the first frame, idle until abort (mirrors a real long-poll
        // fetch that rejects on signal abort) so we measure the re-poll
        // happening while `handle` is still pending.
        return new Promise<RequestFrame | null>((_resolve, reject) => {
          ac.signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      sawFrame = true;
      return Promise.resolve(reqFrame("r1"));
    };

    const handle = (_f: RequestFrame): void => {
      // Simulate a long-lived /events SSE: handle stays pending.
      void handleGate.then(() => {
        handleResolved = true;
      });
    };

    const done = runOverlapScheduler({
      pollOnce,
      handle,
      concurrency: 1,
      signal: ac.signal,
      wait: async () => {},
    });

    // Give the slot ticks to: poll → get frame → detach handle → re-poll.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The slot re-polled even though handle is still pending → detached.
    expect(pollsAfterFrame).toBeGreaterThanOrEqual(1);
    expect(handleResolved).toBe(false);

    releaseHandle();
    ac.abort();
    await done;
  });

  it("backs off on poll rejection then re-polls", async () => {
    const ac = new AbortController();
    let attempts = 0;
    let waits = 0;
    const seenStreaks: number[] = [];

    const pollOnce = (): Promise<RequestFrame | null> => {
      attempts++;
      if (attempts <= 2) return Promise.reject(new Error("boom"));
      // Third attempt succeeds with a 204, then abort to exit.
      ac.abort();
      return Promise.resolve(null);
    };

    const deps: OverlapSchedulerDeps = {
      pollOnce,
      handle: () => {},
      concurrency: 1,
      signal: ac.signal,
      backoff: (streak) => {
        seenStreaks.push(streak);
        return 1;
      },
      wait: async () => {
        waits++;
      },
    };

    await runOverlapScheduler(deps);
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(waits).toBe(2); // two rejections → two backoff waits
    expect(seenStreaks).toEqual([0, 1]); // streak increments across rejections
  });

  it("exits when the signal is already aborted (no polls)", async () => {
    const ac = new AbortController();
    ac.abort();
    let polls = 0;
    await runOverlapScheduler({
      pollOnce: () => {
        polls++;
        return Promise.resolve(null);
      },
      handle: () => {},
      concurrency: 2,
      signal: ac.signal,
      wait: async () => {},
    });
    expect(polls).toBe(0);
  });
});

describe("buildReplyBody — base64 NDJSON framing (landmine #9)", () => {
  function fakeHandler(events: StreamEvent[]): ControlHandler {
    return {
      handle: async () => ({ status: 404 }),
      handleStream: async function* () {
        for (const ev of events) yield ev;
      },
    };
  }

  it("emits headers, base64 chunk(s), then a terminal end", async () => {
    const raw = new Uint8Array([0x41, 0x42, 0x00, 0xff]); // "AB" + binary bytes
    const handler = fakeHandler([
      { type: "headers", status: 200, headers: { "content-type": "x" } },
      { type: "raw-chunk", data: raw },
    ]);
    const body = buildReplyBody(
      handler,
      reqFrame("r1"),
      new AbortController().signal,
    );
    const frames = await readFrames(body);

    expect(frames[0]).toEqual({
      type: "headers",
      status: 200,
      headers: { "content-type": "x" },
    });
    expect(frames[1]).toEqual({
      type: "chunk",
      data: Buffer.from(raw).toString("base64"),
    });
    expect(frames[2]).toEqual({ type: "end" });

    // Round-trip the base64 back to the exact raw bytes.
    const decoded = new Uint8Array(
      Buffer.from((frames[1] as { data: string }).data, "base64"),
    );
    expect(Array.from(decoded)).toEqual(Array.from(raw));
  });

  it("preserves binary bytes that are NOT valid UTF-8 (no lossy decode)", async () => {
    // 0x80 is a lone continuation byte — TextDecoder would turn it into U+FFFD.
    const raw = new Uint8Array([0x80, 0x81, 0x82]);
    const handler = fakeHandler([
      { type: "headers", status: 200, headers: {} },
      { type: "raw-chunk", data: raw },
    ]);
    const frames = await readFrames(
      buildReplyBody(handler, reqFrame("r1"), new AbortController().signal),
    );
    const decoded = new Uint8Array(
      Buffer.from((frames[1] as { data: string }).data, "base64"),
    );
    expect(Array.from(decoded)).toEqual([0x80, 0x81, 0x82]);
  });

  it("emits an error terminal when handleStream throws", async () => {
    const handler: ControlHandler = {
      handle: async () => ({ status: 404 }),
      handleStream: async function* () {
        yield { type: "headers", status: 200, headers: {} };
        throw new Error("upstream boom");
      },
    };
    const frames = await readFrames(
      buildReplyBody(handler, reqFrame("r1"), new AbortController().signal),
    );
    expect(frames[0]!.type).toBe("headers");
    expect(frames[1]).toEqual({
      type: "error",
      code: "handler_error",
      message: "upstream boom",
    });
  });

  it("routes /api/sandboxes (lifecycle) to handle(), NOT handleStream (path routing)", async () => {
    let handleCalls = 0;
    let streamCalls = 0;
    const handler: ControlHandler = {
      handle: async (req) => {
        handleCalls++;
        expect(req.path).toBe("/api/sandboxes");
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: '{"sandboxApiUrl":"http://127.0.0.1:9000"}',
        };
      },
      handleStream: async function* () {
        streamCalls++;
        yield { type: "headers", status: 200, headers: {} };
      },
    };
    const frame: RequestFrame = {
      type: "request",
      reqId: "r1",
      method: "POST",
      path: "/api/sandboxes",
      headers: {},
      body: '{"handle":"abc"}',
    };
    const frames = await readFrames(
      buildReplyBody(handler, frame, new AbortController().signal),
    );

    expect(handleCalls).toBe(1);
    expect(streamCalls).toBe(0);
    // headers → base64 chunk → end (uniform shape, same as the streaming path).
    expect(frames[0]).toEqual({
      type: "headers",
      status: 200,
      headers: { "content-type": "application/json" },
    });
    expect(frames[1]!.type).toBe("chunk");
    const decoded = Buffer.from(
      (frames[1] as { data: string }).data,
      "base64",
    ).toString("utf8");
    expect(JSON.parse(decoded)).toEqual({
      sandboxApiUrl: "http://127.0.0.1:9000",
    });
    expect(frames[2]).toEqual({ type: "end" });
  });

  it("routes DELETE /api/sandboxes/<handle> to handle() with no body chunk (204)", async () => {
    let handleCalls = 0;
    const handler: ControlHandler = {
      handle: async (req) => {
        handleCalls++;
        expect(req.method).toBe("DELETE");
        expect(req.path).toBe("/api/sandboxes/h1");
        return { status: 204 };
      },
      // eslint-disable-next-line require-yield -- asserts non-invocation
      handleStream: async function* () {
        throw new Error("handleStream must not be called for /api/sandboxes/*");
      },
    };
    const frame: RequestFrame = {
      type: "request",
      reqId: "r1",
      method: "DELETE",
      path: "/api/sandboxes/h1",
      headers: {},
    };
    const frames = await readFrames(
      buildReplyBody(handler, frame, new AbortController().signal),
    );
    expect(handleCalls).toBe(1);
    expect(frames).toEqual([
      { type: "headers", status: 204, headers: {} },
      { type: "end" },
    ]);
  });

  it("routes /_sandbox/* to handleStream, NOT handle (path routing)", async () => {
    let handleCalls = 0;
    let streamCalls = 0;
    const handler: ControlHandler = {
      handle: async () => {
        handleCalls++;
        return { status: 404 };
      },
      handleStream: async function* (req) {
        streamCalls++;
        expect(req.path).toBe("/_sandbox/h1/events");
        yield { type: "headers", status: 200, headers: {} };
        yield { type: "raw-chunk", data: new Uint8Array([1, 2, 3]) };
      },
    };
    const frames = await readFrames(
      buildReplyBody(
        handler,
        reqFrame("r1", "/_sandbox/h1/events"),
        new AbortController().signal,
      ),
    );
    expect(streamCalls).toBe(1);
    expect(handleCalls).toBe(0);
    expect(frames[0]!.type).toBe("headers");
    expect(frames[1]).toEqual({
      type: "chunk",
      data: Buffer.from([1, 2, 3]).toString("base64"),
    });
    expect(frames[2]).toEqual({ type: "end" });
  });

  it("surfaces a handle() throw as an error terminal (lifecycle path)", async () => {
    const handler: ControlHandler = {
      handle: async () => {
        throw new Error("ensure boom");
      },
      handleStream: async function* () {},
    };
    const frames = await readFrames(
      buildReplyBody(
        handler,
        {
          type: "request",
          reqId: "r1",
          method: "POST",
          path: "/api/sandboxes",
          headers: {},
        },
        new AbortController().signal,
      ),
    );
    expect(frames[0]).toEqual({
      type: "error",
      code: "handler_error",
      message: "ensure boom",
    });
  });

  it("emits a cancelled error terminal when the signal is aborted", async () => {
    const ac = new AbortController();
    // A handler that yields headers, then blocks until aborted (models /events).
    const handler: ControlHandler = {
      handle: async () => ({ status: 404 }),
      handleStream: async function* (_req, signal) {
        yield { type: "headers", status: 200, headers: {} };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        // Generator returns quietly on abort (mirrors control-handler).
      },
    };
    const body = buildReplyBody(handler, reqFrame("r1"), ac.signal);
    const reader = body.getReader();
    const dec = new TextDecoder();

    // First pull → headers frame.
    const first = await reader.read();
    expect(dec.decode(first.value)).toContain('"type":"headers"');

    // Abort, then the next pull resolves (generator returns) → cancelled frame.
    ac.abort();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += dec.decode(value, { stream: true });
    }
    expect(rest).toContain('"type":"error"');
    expect(rest).toContain('"code":"cancelled"');
  });
});
