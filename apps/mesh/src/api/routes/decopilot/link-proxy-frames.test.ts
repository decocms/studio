import { describe, expect, test } from "bun:test";
import {
  decodeProxyReplyFrame,
  encodeProxyReplyFrame,
  splitNdjsonLines,
  type ProxyReplyFrame,
} from "./link-proxy-frames";

describe("link-proxy-frames codec", () => {
  test("round-trips a headers frame", () => {
    const frame: ProxyReplyFrame = {
      type: "headers",
      status: 200,
      headers: { "content-type": "text/event-stream" },
    };
    expect(decodeProxyReplyFrame(encodeProxyReplyFrame(frame))).toEqual(frame);
  });

  test("round-trips a base64 chunk frame", () => {
    const frame: ProxyReplyFrame = {
      type: "chunk",
      data: Buffer.from("hello\nworld").toString("base64"),
    };
    const decoded = decodeProxyReplyFrame(encodeProxyReplyFrame(frame));
    expect(decoded).toEqual(frame);
    // base64 never contains a newline, so it is safe to line-delimit.
    expect(encodeProxyReplyFrame(frame)).not.toContain("\n");
  });

  test("round-trips end and error frames", () => {
    expect(decodeProxyReplyFrame('{"type":"end"}')).toEqual({ type: "end" });
    expect(
      decodeProxyReplyFrame('{"type":"error","code":"x","message":"boom"}'),
    ).toEqual({ type: "error", code: "x", message: "boom" });
  });

  test("throws on malformed JSON", () => {
    expect(() => decodeProxyReplyFrame("{not json")).toThrow(/malformed JSON/);
  });

  test("throws on unknown frame type", () => {
    expect(() => decodeProxyReplyFrame('{"type":"bogus"}')).toThrow(
      /unknown frame type/,
    );
  });

  test("throws on invalid status range", () => {
    expect(() =>
      decodeProxyReplyFrame('{"type":"headers","status":99,"headers":{}}'),
    ).toThrow();
  });
});

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
}

describe("splitNdjsonLines", () => {
  test("splits complete lines and drops empties", async () => {
    const lines: string[] = [];
    for await (const line of splitNdjsonLines(
      streamFromString('{"a":1}\n\n{"b":2}\n'),
    )) {
      lines.push(line);
    }
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("yields the trailing line with no terminating newline", async () => {
    const lines: string[] = [];
    for await (const line of splitNdjsonLines(streamFromString('{"a":1}'))) {
      lines.push(line);
    }
    expect(lines).toEqual(['{"a":1}']);
  });

  test("reassembles a line split across reads (and multi-byte char)", async () => {
    const enc = new TextEncoder();
    const full = '{"emoji":"😀"}\n';
    const bytes = enc.encode(full);
    // Split inside the 4-byte emoji AND inside the JSON.
    const cut = bytes.indexOf(0xf0); // first byte of the emoji
    const chunks = [bytes.slice(0, cut + 2), bytes.slice(cut + 2)];
    const lines: string[] = [];
    for await (const line of splitNdjsonLines(streamFromChunks(chunks))) {
      lines.push(line);
    }
    expect(lines).toEqual(['{"emoji":"😀"}']);
  });

  test("never buffers more than the current incomplete line", async () => {
    // Two complete lines arrive in one read followed by a partial third — the
    // first two must be yielded before the third completes (streaming, not
    // buffer-the-whole-body).
    const enc = new TextEncoder();
    const chunks = [enc.encode('{"a":1}\n{"b":2}\n{"c"'), enc.encode(":3}\n")];
    const lines: string[] = [];
    for await (const line of splitNdjsonLines(streamFromChunks(chunks))) {
      lines.push(line);
    }
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});
