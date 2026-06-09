import { describe, expect, it } from "bun:test";
import { isFinalPart, PartRowBuilder } from "./part-row-builder";

describe("PartRowBuilder", () => {
  it("builds deterministic final rows and a finish anchor", () => {
    const builder = new PartRowBuilder({
      orgId: "org_1",
      threadId: "thread_1",
      runId: "thread_1",
      baseTimeMs: 1_700_000_000_000,
    });

    const rows = builder.emitFinal({
      id: "assistant_1",
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
    });

    expect(
      rows.map((row) => ({
        id: row.id,
        seq: row.seq,
        kind: row.kind,
        message_id: row.message_id,
        role: row.role,
        payload: row.payload,
        created_at: row.created_at,
      })),
    ).toEqual([
      {
        id: "thread_1:0",
        seq: 0,
        kind: "text",
        message_id: "assistant_1",
        role: "assistant",
        payload: { type: "text", text: "hello" },
        created_at: "2023-11-14T22:13:20.000Z",
      },
      {
        id: "thread_1:1",
        seq: 1,
        kind: "finish",
        message_id: "assistant_1",
        role: "assistant",
        payload: {},
        created_at: "2023-11-14T22:13:20.001Z",
      },
    ]);
  });

  it("is idempotent for repeated step and final snapshots", () => {
    const builder = new PartRowBuilder({
      orgId: "org_1",
      threadId: "thread_1",
      runId: "thread_1",
      baseTimeMs: 1_700_000_000_000,
    });
    const message = {
      id: "assistant_1",
      role: "assistant" as const,
      parts: [{ type: "text", text: "hello" }],
    };

    const firstStep = builder.emitStepParts(message);
    builder.acknowledge(firstStep);
    const secondStep = builder.emitStepParts(message);
    const finalRows = builder.emitFinal(message);
    builder.acknowledge(finalRows);
    const repeatedFinalRows = builder.emitFinal(message);

    expect(firstStep.map((row) => row.id)).toEqual(["thread_1:0"]);
    expect(secondStep).toEqual([]);
    expect(finalRows.map((row) => [row.id, row.kind])).toEqual([
      ["thread_1:1", "finish"],
    ]);
    expect(repeatedFinalRows).toEqual([]);
  });

  it("emits a skipped in-flight tool part when the same index becomes terminal", () => {
    const builder = new PartRowBuilder({
      orgId: "org_1",
      threadId: "thread_1",
      runId: "thread_1",
      baseTimeMs: 1_700_000_000_000,
    });

    const firstStep = builder.emitStepParts({
      id: "assistant_1",
      role: "assistant",
      parts: [{ type: "tool-search", state: "input-available", input: {} }],
    });
    const secondStep = builder.emitStepParts({
      id: "assistant_1",
      role: "assistant",
      parts: [
        {
          type: "tool-search",
          state: "output-available",
          input: {},
          output: "ok",
        },
      ],
    });

    expect(firstStep).toEqual([]);
    expect(
      secondStep.map((row) => ({
        id: row.id,
        seq: row.seq,
        kind: row.kind,
        payload: row.payload,
      })),
    ).toEqual([
      {
        id: "thread_1:0",
        seq: 0,
        kind: "tool_result",
        payload: {
          type: "tool-search",
          state: "output-available",
          input: {},
          output: "ok",
        },
      },
    ]);
  });

  it("builds an error part and closes the assistant message", () => {
    const builder = new PartRowBuilder({
      orgId: "org_1",
      threadId: "thread_1",
      runId: "thread_1",
      baseTimeMs: 1_700_000_000_000,
    });

    const rows = builder.emitError("error_msg", "desktop failed");

    expect(rows.map((row) => [row.id, row.kind, row.payload])).toEqual([
      ["thread_1:0", "error", { type: "text", text: "Error: desktop failed" }],
      ["thread_1:1", "finish", {}],
    ]);
  });

  it("does not freeze streaming text", () => {
    expect(isFinalPart({ type: "text", state: "streaming", text: "he" })).toBe(
      false,
    );
    expect(isFinalPart({ type: "text", state: "done", text: "hello" })).toBe(
      true,
    );
  });
});
