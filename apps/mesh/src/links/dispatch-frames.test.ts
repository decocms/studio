import { describe, expect, test } from "bun:test";
import {
  decodeFrame,
  encodeFrame,
  type DispatchFrame,
} from "./dispatch-frames";

describe("dispatch-frames codec", () => {
  test("round-trips a hello frame", () => {
    const frame: DispatchFrame = {
      type: "hello",
      previewPort: 5174,
      machineId: "m-abc",
      hostname: "laptop.local",
      cliVersion: "1.2.3",
      capabilities: ["decopilot-sandbox"],
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  test("round-trips a request frame", () => {
    const frame: DispatchFrame = {
      type: "request",
      reqId: "r-1",
      method: "POST",
      path: "/_sandbox/dispatch",
      headers: { "content-type": "application/json" },
      body: '{"x":1}',
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  test("round-trips a chunk frame", () => {
    const frame: DispatchFrame = { type: "chunk", reqId: "r-1", data: "hello" };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  test("round-trips end and error frames", () => {
    const end: DispatchFrame = { type: "end", reqId: "r-1" };
    expect(decodeFrame(encodeFrame(end))).toEqual(end);
    const err: DispatchFrame = {
      type: "error",
      reqId: "r-1",
      code: "BOOM",
      message: "kaboom",
    };
    expect(decodeFrame(encodeFrame(err))).toEqual(err);
  });

  test("round-trips a cancel frame", () => {
    const frame: DispatchFrame = { type: "cancel", reqId: "r-1" };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  test("rejects unknown type", () => {
    expect(() => decodeFrame('{"type":"nope","reqId":"r-1"}')).toThrow(
      /unknown frame type/i,
    );
  });

  test("rejects missing reqId on non-hello frames", () => {
    expect(() => decodeFrame('{"type":"chunk","data":"x"}')).toThrow();
  });

  test("rejects malformed JSON", () => {
    expect(() => decodeFrame("not-json")).toThrow();
  });
});
