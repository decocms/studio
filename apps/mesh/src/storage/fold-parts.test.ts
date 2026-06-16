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
      { type: "text", text: "A", created_at: "2026-01-01T00:00:00.000Z" },
      { type: "text", text: "B", created_at: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("preserves each part's own created_at on the part", () => {
    const out = foldParts([
      part({
        id: "r1:0",
        seq: 0,
        payload: { type: "tool-bash", state: "input-available" },
        created_at: "2026-01-01T00:00:01.000Z",
      }),
      part({
        id: "r1:1",
        seq: 1,
        payload: { type: "text", text: "B" },
        created_at: "2026-01-01T00:00:09.000Z",
      }),
    ]);
    expect(out[0]!.parts).toEqual([
      {
        type: "tool-bash",
        state: "input-available",
        created_at: "2026-01-01T00:00:01.000Z",
      },
      { type: "text", text: "B", created_at: "2026-01-01T00:00:09.000Z" },
    ]);
  });

  it("orders parts within a message by seq regardless of input order (C5)", () => {
    const out = foldParts([
      part({ id: "r1:2", seq: 2, payload: { type: "text", text: "C" } }),
      part({ id: "r1:0", seq: 0, payload: { type: "text", text: "A" } }),
      part({ id: "r1:1", seq: 1, payload: { type: "text", text: "B" } }),
    ]);
    expect(out[0]!.parts).toEqual([
      { type: "text", text: "A", created_at: "2026-01-01T00:00:00.000Z" },
      { type: "text", text: "B", created_at: "2026-01-01T00:00:00.000Z" },
      { type: "text", text: "C", created_at: "2026-01-01T00:00:00.000Z" },
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

  it("folds the combined rows of two same-thread messages built by separate per-message builders (pull turn: user + assistant)", () => {
    // Regression: the PULL path persists the user message and the assistant
    // message via two SEPARATE PartRowBuilders sharing run_id == thread_id,
    // each with seq restarting at 0. Per-message-scoped ids
    // (`${runId}:${messageId}:${seq}`) keep their rows distinct, and distinct
    // baseTimeMs (dispatch time vs later relay time) keeps the user message
    // ordered before the assistant message by created_at.
    const userBase = "2026-01-01T00:00:01.000"; // dispatch time
    const assistantBase = "2026-01-01T00:00:02.000"; // later relay time
    const out = foldParts([
      // user message (builder A, seq 0,1)
      part({
        id: "t1:user_1:0",
        seq: 0,
        run_id: "t1",
        message_id: "user_1",
        role: "user",
        payload: { type: "text", text: "question" },
        created_at: `${userBase}Z`,
      }),
      part({
        id: "t1:user_1:1",
        seq: 1,
        run_id: "t1",
        message_id: "user_1",
        role: "user",
        kind: "finish",
        payload: {},
        created_at: `${userBase}Z`,
      }),
      // assistant message (builder B, seq restarts at 0,1)
      part({
        id: "t1:assistant_1:0",
        seq: 0,
        run_id: "t1",
        message_id: "assistant_1",
        role: "assistant",
        payload: { type: "text", text: "answer" },
        created_at: `${assistantBase}Z`,
      }),
      part({
        id: "t1:assistant_1:1",
        seq: 1,
        run_id: "t1",
        message_id: "assistant_1",
        role: "assistant",
        kind: "finish",
        payload: {},
        created_at: `${assistantBase}Z`,
      }),
    ]);

    // Both messages survive (neither set was dropped by an id collision) and
    // order user-before-assistant by created_at.
    expect(out.map((m) => m.id)).toEqual(["user_1", "assistant_1"]);
    expect(out[0]!.parts).toEqual([
      { type: "text", text: "question", created_at: `${userBase}Z` },
    ]);
    expect(out[1]!.parts).toEqual([
      { type: "text", text: "answer", created_at: `${assistantBase}Z` },
    ]);
    expect(out[0]!.status).toBe("complete");
    expect(out[1]!.status).toBe("complete");
  });

  it("exposes finish-anchor metadata on the folded message", () => {
    const textRow = part({
      id: "r1:0",
      seq: 0,
      kind: "text",
      payload: { type: "text", text: "hi" },
    });
    const finishRow = part({
      id: "r1:1",
      seq: 1,
      kind: "finish",
      payload: {},
      metadata: {
        codingAgentSessionId: "sess-1",
        codingAgentProvider: "claude-code",
      },
    });
    const folded = foldParts([textRow, finishRow]);
    expect(folded[0]?.metadata).toMatchObject({
      codingAgentSessionId: "sess-1",
    });
  });
});
