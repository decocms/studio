import { describe, expect, test } from "bun:test";
import { synthesizedErrorMessageId } from "@/api/routes/decopilot/message-ids";
import { buildTerminalErrorChunks } from "./hosted-harness-workflow";

describe("buildTerminalErrorChunks", () => {
  test("carries the REAL err.message verbatim — never a masked/generic string", () => {
    const result = buildTerminalErrorChunks(
      "thread-1",
      "fence-a",
      new Error("tool call exploded: ECONNRESET talking to upstream MCP"),
    );

    expect(result.errorChunk).toEqual({
      type: "error",
      errorText: "tool call exploded: ECONNRESET talking to upstream MCP",
    });
  });

  test("stringifies a non-Error thrown value", () => {
    const result = buildTerminalErrorChunks("thread-1", "fence-a", "boom");

    expect(result.errorChunk).toEqual({ type: "error", errorText: "boom" });
  });

  test("uses the SAME deterministic id the projector computes for its own synthesized error", () => {
    const result = buildTerminalErrorChunks(
      "thread-1",
      "fence-a",
      new Error("x"),
    );

    // The durable projector independently calls synthesizedErrorMessageId with
    // the same (runId, fenceToken) when IT synthesizes an error message from
    // this same chunk (see projector-workflow.ts) — so a projector retry's
    // emitError collapses onto this SAME row (ON CONFLICT DO NOTHING) instead
    // of duplicating it.
    expect(result.messageId).toBe(
      synthesizedErrorMessageId("thread-1", "fence-a"),
    );
  });

  test("defaults the error chunk and paired {done} sentinel to seq 1", () => {
    const result = buildTerminalErrorChunks(
      "thread-1",
      "fence-a",
      new Error("x"),
    );

    expect(result.seq).toBe(1);
    expect(result.finalSeq).toBe(1);
  });

  test("continues the run's seq counter from an explicit startSeq", () => {
    const result = buildTerminalErrorChunks(
      "thread-1",
      "fence-a",
      new Error("x"),
      7,
    );

    expect(result.seq).toBe(7);
    expect(result.finalSeq).toBe(7);
  });

  test("distinct turns of the same thread never collide", () => {
    const turnOne = buildTerminalErrorChunks(
      "thread-1",
      "fence-a",
      new Error("x"),
    );
    const turnTwo = buildTerminalErrorChunks(
      "thread-1",
      "fence-b",
      new Error("x"),
    );

    expect(turnOne.messageId).not.toBe(turnTwo.messageId);
  });
});
