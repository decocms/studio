import { describe, it, expect } from "bun:test";
import { foldParts, type ThreadMessagePart } from "./fold-parts";

const part = (p: Partial<ThreadMessagePart>): ThreadMessagePart => ({
  id: "r1:0",
  seq: 0,
  org_id: "org_1",
  thread_id: "t1",
  run_id: "r1",
  message_id: "m1",
  role: "assistant",
  kind: "text",
  payload: { type: "text", text: "" },
  payload_ref: null,
  metadata: null,
  created_at: "2026-01-01T00:00:00.000Z",
  ...p,
});

describe("foldParts", () => {
  it("groups parts into one message by message_id", () => {
    const out = foldParts([
      part({
        id: "r1:0",
        seq: 0,
        message_id: "m1",
        payload: { type: "text", text: "A" },
      }),
      part({
        id: "r1:1",
        seq: 1,
        message_id: "m1",
        payload: { type: "text", text: "B" },
      }),
      part({
        id: "r1:2",
        seq: 2,
        message_id: "m1",
        kind: "finish",
        payload: {},
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("m1");
    expect(out[0]!.parts).toEqual([
      { type: "text", text: "A" },
      { type: "text", text: "B" },
    ]);
  });

  it("orders parts within a message by seq regardless of input order (C5)", () => {
    const out = foldParts([
      part({ id: "r1:2", seq: 2, payload: { type: "text", text: "C" } }),
      part({ id: "r1:0", seq: 0, payload: { type: "text", text: "A" } }),
      part({ id: "r1:1", seq: 1, payload: { type: "text", text: "B" } }),
    ]);
    expect(out[0]!.parts).toEqual([
      { type: "text", text: "A" },
      { type: "text", text: "B" },
      { type: "text", text: "C" },
    ]);
  });

  it("marks a message with no finish part as in_progress", () => {
    const out = foldParts([
      part({ kind: "text", payload: { type: "text", text: "partial" } }),
    ]);
    expect(out[0]!.status).toBe("in_progress");
  });

  it("marks a message with a finish part as complete", () => {
    const out = foldParts([
      part({ id: "r1:0", seq: 0, payload: { type: "text", text: "done" } }),
      part({ id: "r1:1", seq: 1, kind: "finish", payload: {} }),
    ]);
    expect(out[0]!.status).toBe("complete");
  });

  it("orders messages across runs by created_at (C5 cross-message)", () => {
    const out = foldParts([
      part({
        id: "r2:0",
        run_id: "r2",
        message_id: "m2",
        created_at: "2026-01-01T00:00:05.000Z",
      }),
      part({
        id: "r1:0",
        run_id: "r1",
        message_id: "m1",
        created_at: "2026-01-01T00:00:01.000Z",
      }),
    ]);
    expect(out.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("is idempotent (folding the same input twice yields equal output)", () => {
    const input = [
      part({ id: "r1:0", seq: 0 }),
      part({ id: "r1:1", seq: 1, kind: "finish", payload: {} }),
    ];
    expect(foldParts(input)).toEqual(foldParts(input));
  });
});
