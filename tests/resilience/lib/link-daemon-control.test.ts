import { describe, expect, test } from "bun:test";
import { parseSseLogFrames } from "./link-daemon-control";

describe("parseSseLogFrames", () => {
  test("extracts log frames keyed by source", () => {
    const raw =
      'event: lifecycle\ndata: {"state":"running"}\n\n' +
      'event: log\ndata: {"source":"marker","data":"hello MARKER-123\\n"}\n\n' +
      'event: log\ndata: {"source":"daemon","data":"GET /\\r\\n"}\n\n';
    const frames = parseSseLogFrames(raw);
    expect(frames.find((f) => f.source === "marker")?.data).toContain(
      "MARKER-123",
    );
    expect(frames.some((f) => f.source === "daemon")).toBe(true);
  });

  test("ignores non-log events and malformed data", () => {
    const raw =
      'event: status\ndata: {"running":true}\n\n' +
      "event: log\ndata: not-json\n\n";
    expect(parseSseLogFrames(raw)).toEqual([]);
  });

  test("handles CRLF line endings and no-space event field", () => {
    const raw =
      'event:log\r\ndata: {"source":"marker","data":"CRLF-OK"}\r\n\r\n';
    const frames = parseSseLogFrames(raw);
    expect(frames.find((f) => f.source === "marker")?.data).toBe("CRLF-OK");
  });
});
