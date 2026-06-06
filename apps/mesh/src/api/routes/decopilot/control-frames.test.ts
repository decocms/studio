import { describe, expect, test } from "bun:test";
import { decodeControlFrame, encodeControlFrame } from "./control-frames";

describe("control-frames codec", () => {
  test("round-trip cancel frame", () => {
    const frame = { type: "cancel" as const, runId: "run_abc123" };
    const encoded = encodeControlFrame(frame);
    const decoded = decodeControlFrame(encoded);
    expect(decoded).toEqual(frame);
  });

  test("round-trip keep_alive frame", () => {
    const frame = { type: "keep_alive" as const };
    const encoded = encodeControlFrame(frame);
    const decoded = decodeControlFrame(encoded);
    expect(decoded).toEqual(frame);
  });

  test("decodeControlFrame throws on unknown type", () => {
    expect(() => decodeControlFrame('{"type":"bogus"}')).toThrow();
  });
});
