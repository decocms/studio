import { describe, expect, it } from "bun:test";
import type { UIMessageChunk } from "ai";
import { parseDispatchSSEStream } from "./parse-dispatch-sse";

function sseStream(blocks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const b of blocks) controller.enqueue(enc.encode(b));
      controller.close();
    },
  });
}

async function collect(
  it: AsyncIterable<UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("parseDispatchSSEStream", () => {
  it("yields ui-message-chunk payloads, ignores done", async () => {
    const body = sseStream([
      'data: {"type":"ui-message-chunk","chunk":{"type":"text-delta","id":"m1","delta":"hi"}}\n\n',
      'data: {"type":"done"}\n\n',
    ]);
    const chunks = await collect(parseDispatchSSEStream(body));
    expect(chunks).toEqual([{ type: "text-delta", id: "m1", delta: "hi" }]);
  });

  it("reassembles an event split across read boundaries", async () => {
    const body = sseStream([
      'data: {"type":"ui-message-chunk","chunk":{"type":"text-',
      'delta","id":"m1","delta":"hi"}}\n\n',
    ]);
    const chunks = await collect(parseDispatchSSEStream(body));
    expect(chunks).toEqual([{ type: "text-delta", id: "m1", delta: "hi" }]);
  });

  it("throws on an error event", async () => {
    const body = sseStream([
      'data: {"type":"error","code":"harness_crashed","message":"boom"}\n\n',
    ]);
    await expect(collect(parseDispatchSSEStream(body))).rejects.toThrow("boom");
  });
});
