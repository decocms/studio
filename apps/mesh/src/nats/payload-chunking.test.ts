import { describe, expect, test } from "bun:test";
import { MAX_PUBLISH_BYTES, splitChunkData } from "./payload-chunking";

const enc = new TextEncoder();
const frameBytes = (reqId: string, data: string) =>
  enc.encode(JSON.stringify({ type: "chunk", reqId, data })).length;

describe("splitChunkData", () => {
  test("returns the input unchanged when it already fits", () => {
    const data = "hello world";
    const overhead = frameBytes("r1", "");
    expect(splitChunkData(data, MAX_PUBLISH_BYTES, overhead)).toEqual([data]);
  });

  test("splits oversized data so each piece's frame fits, and concatenation is exact", () => {
    const data = "x".repeat(MAX_PUBLISH_BYTES * 3 + 1234);
    const overhead = frameBytes("req-1234", "");
    const pieces = splitChunkData(data, MAX_PUBLISH_BYTES, overhead);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(frameBytes("req-1234", p)).toBeLessThanOrEqual(MAX_PUBLISH_BYTES);
    }
    expect(pieces.join("")).toBe(data);
  });

  test("is safe for JSON-special characters (escaping never overflows the budget)", () => {
    // Every char escapes to 2 bytes ("\\\"" / "\\\\" / "\\n"); still must fit.
    const data = '"\\\n'.repeat(MAX_PUBLISH_BYTES); // far larger than one frame
    const overhead = frameBytes("r", "");
    const pieces = splitChunkData(data, MAX_PUBLISH_BYTES, overhead);
    for (const p of pieces) {
      expect(frameBytes("r", p)).toBeLessThanOrEqual(MAX_PUBLISH_BYTES);
    }
    expect(pieces.join("")).toBe(data);
  });

  test("is safe for multibyte / surrogate-pair content", () => {
    const data = "😀🎉".repeat(MAX_PUBLISH_BYTES); // 4-byte UTF-8, surrogate pairs
    const overhead = frameBytes("r", "");
    const pieces = splitChunkData(data, MAX_PUBLISH_BYTES, overhead);
    for (const p of pieces) {
      expect(frameBytes("r", p)).toBeLessThanOrEqual(MAX_PUBLISH_BYTES);
    }
    expect(pieces.join("")).toBe(data);
  });

  test("boundary: every returned piece's frame stays within the budget", () => {
    const overhead = frameBytes("r", "");
    const justUnder = "a".repeat(MAX_PUBLISH_BYTES);
    for (const p of splitChunkData(justUnder, MAX_PUBLISH_BYTES, overhead)) {
      expect(frameBytes("r", p)).toBeLessThanOrEqual(MAX_PUBLISH_BYTES);
    }
  });
});
