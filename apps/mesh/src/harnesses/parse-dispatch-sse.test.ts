import { describe, expect, it } from "bun:test";
import type { DispatchSSEEvent } from "../links/protocol";
import { parseDispatchSSEEvents } from "./parse-dispatch-sse";

function sseStream(blocks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const b of blocks) controller.enqueue(enc.encode(b));
      controller.close();
    },
  });
}

async function collectEvents(
  events: AsyncIterable<DispatchSSEEvent>,
): Promise<DispatchSSEEvent[]> {
  const out: DispatchSSEEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe("parseDispatchSSEEvents", () => {
  it("yields raw validated events including done", async () => {
    const body = sseStream([
      'data: {"type":"ui-message-chunk","chunk":{"type":"text-delta","id":"m1","delta":"hi"}}\n\n',
      'data: {"type":"done"}\n\n',
    ]);
    const events = await collectEvents(parseDispatchSSEEvents(body));
    expect(events).toEqual([
      {
        type: "ui-message-chunk",
        chunk: { type: "text-delta", id: "m1", delta: "hi" },
      },
      { type: "done" },
    ]);
  });

  it("yields error events instead of throwing", async () => {
    const body = sseStream([
      'data: {"type":"error","code":"harness_crashed","message":"boom"}\n\n',
      'data: {"type":"done"}\n\n',
    ]);
    const events = await collectEvents(parseDispatchSSEEvents(body));
    expect(events).toEqual([
      { type: "error", code: "harness_crashed", message: "boom" },
      { type: "done" },
    ]);
  });

  it("reassembles an event split across chunk boundaries", async () => {
    const body = sseStream([
      'data: {"type":"ui-message-chunk","chunk":{"type":"text-',
      'delta","id":"m1","delta":"hi"}}\n\ndata: {"type":"done"}\n\n',
    ]);
    const events = await collectEvents(parseDispatchSSEEvents(body));
    expect(events).toEqual([
      {
        type: "ui-message-chunk",
        chunk: { type: "text-delta", id: "m1", delta: "hi" },
      },
      { type: "done" },
    ]);
  });

  it("skips malformed frames (bad JSON, unknown type)", async () => {
    const body = sseStream([
      "data: {not-json\n\n",
      'data: {"type":"mystery"}\n\n',
      ": comment-only block\n\n",
      'data: {"type":"done"}\n\n',
    ]);
    const events = await collectEvents(parseDispatchSSEEvents(body));
    expect(events).toEqual([{ type: "done" }]);
  });

  it("yields a tail event when the body closes without the final \\n\\n", async () => {
    const body = sseStream(['data: {"type":"done"}']);
    const events = await collectEvents(parseDispatchSSEEvents(body));
    expect(events).toEqual([{ type: "done" }]);
  });

  it("rejects with the abort reason when the signal fires mid-stream and cancels the source", async () => {
    let sourceCancelled = false;
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode(
            'data: {"type":"ui-message-chunk","chunk":{"type":"text-delta","id":"m1","delta":"hi"}}\n\n',
          ),
        );
        // Never closes — simulates a quiet but live SSE stream.
      },
      cancel() {
        sourceCancelled = true;
      },
    });

    const ac = new AbortController();
    const reason = new Error("relay torn down");
    const events = parseDispatchSSEEvents(body, { signal: ac.signal });

    const iterator = events[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({
      type: "ui-message-chunk",
      chunk: { type: "text-delta", id: "m1", delta: "hi" },
    });

    const pending = iterator.next();
    ac.abort(reason);
    await expect(pending).rejects.toThrow("relay torn down");
    expect(sourceCancelled).toBe(true);
  });
});
