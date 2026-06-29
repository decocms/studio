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
        id: "thread_1:assistant_1:0",
        seq: 0,
        kind: "text",
        message_id: "assistant_1",
        role: "assistant",
        payload: { type: "text", text: "hello" },
        created_at: "2023-11-14T22:13:20.000Z",
      },
      {
        id: "thread_1:assistant_1:1",
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

    expect(firstStep.map((row) => row.id)).toEqual(["thread_1:assistant_1:0"]);
    expect(secondStep).toEqual([]);
    expect(finalRows.map((row) => [row.id, row.kind])).toEqual([
      ["thread_1:assistant_1:1", "finish"],
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
        id: "thread_1:assistant_1:0",
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

  it("persists requires-action tool states on terminal projection", () => {
    const builder = new PartRowBuilder({
      orgId: "org_1",
      threadId: "thread_1",
      runId: "thread_1",
      baseTimeMs: 1_700_000_000_000,
    });

    const rows = builder.emitFinal({
      id: "assistant_1",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          state: "approval-requested",
          toolCallId: "tc_1",
          input: { command: "echo ok" },
        },
        {
          type: "tool-user_ask",
          state: "input-available",
          toolCallId: "tc_2",
          input: { question: "continue?" },
        },
        {
          type: "tool-search",
          state: "input-available",
          toolCallId: "tc_3",
          input: { query: "still running" },
        },
      ],
    });

    expect(rows.map((row) => [row.kind, row.payload])).toEqual([
      [
        "tool_call",
        {
          type: "tool-bash",
          state: "approval-requested",
          toolCallId: "tc_1",
          input: { command: "echo ok" },
        },
      ],
      [
        "tool_call",
        {
          type: "tool-user_ask",
          state: "input-available",
          toolCallId: "tc_2",
          input: { question: "continue?" },
        },
      ],
      ["finish", {}],
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
      [
        "thread_1:error_msg:0",
        "error",
        { type: "text", text: "Error: desktop failed" },
      ],
      ["thread_1:error_msg:1", "finish", {}],
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

  it("two builders sharing a runId but distinct message ids produce disjoint row ids (pull turn: user vs assistant)", () => {
    // Regression for the v2 part-id collision: in the PULL path the user
    // message and assistant message are projected by separate PartRowBuilders,
    // both with runId == threadId and seq restarting at 0. With per-RUN ids
    // (`${runId}:${seq}`) the assistant's `${threadId}:0`/`:1` collided with
    // the user's and were dropped by ON CONFLICT DO NOTHING. Per-MESSAGE ids
    // (`${runId}:${messageId}:${seq}`) must keep the two sets disjoint.
    const shared = {
      orgId: "org_1",
      threadId: "thread_1",
      runId: "thread_1",
    };

    const userBuilder = new PartRowBuilder({ ...shared, baseTimeMs: 1_000 });
    const userRows = userBuilder.emitUserMessage({
      id: "user_1",
      role: "user",
      parts: [{ type: "text", text: "question" }],
    });

    const assistantBuilder = new PartRowBuilder({
      ...shared,
      baseTimeMs: 2_000,
    });
    const assistantRows = assistantBuilder.emitFinal({
      id: "assistant_1",
      role: "assistant",
      parts: [{ type: "text", text: "answer" }],
    });

    const userIds = userRows.map((r) => r.id);
    const assistantIds = assistantRows.map((r) => r.id);

    // Both builders allocate seq 0,1 — but the messageId segment keeps the ids
    // distinct, so neither set would be dropped by an id conflict.
    expect(userIds).toEqual(["thread_1:user_1:0", "thread_1:user_1:1"]);
    expect(assistantIds).toEqual([
      "thread_1:assistant_1:0",
      "thread_1:assistant_1:1",
    ]);
    const overlap = userIds.filter((id) => assistantIds.includes(id));
    expect(overlap).toEqual([]);
  });

  it("emitFinal writes NOTHING for a message with no renderable parts (no empty bubble)", () => {
    const builder = new PartRowBuilder({
      orgId: "org_1",
      threadId: "thread_1",
      runId: "thread_1",
      baseTimeMs: 1_700_000_000_000,
    });

    // A finish with zero content (e.g. the stream ended with only a
    // still-`streaming` text part that never reached `done`) must not persist
    // a lone finish anchor — that would fold to an empty assistant message.
    const noParts = builder.emitFinal({ id: "assistant_1", role: "assistant" });
    const streamingOnly = builder.emitFinal({
      id: "assistant_2",
      role: "assistant",
      parts: [{ type: "text", state: "streaming", text: "par" }],
    });

    expect(noParts).toEqual([]);
    expect(streamingOnly).toEqual([]);
  });

  it("emitFinal still closes a message whose content was emitted in an earlier step", () => {
    const builder = new PartRowBuilder({
      orgId: "org_1",
      threadId: "thread_1",
      runId: "thread_1",
      baseTimeMs: 1_700_000_000_000,
    });
    const message = {
      id: "assistant_1",
      role: "assistant" as const,
      parts: [{ type: "text", state: "done", text: "hello" }],
    };

    builder.acknowledge(builder.emitStepParts(message));
    // emitFinal sees no NEW content rows, but the message already has content,
    // so the finish anchor must still be written.
    const finalRows = builder.emitFinal(message);

    expect(finalRows.map((r) => [r.id, r.kind])).toEqual([
      ["thread_1:assistant_1:1", "finish"],
    ]);
  });

  it("emitFinal carries the message metadata on the finish anchor row", () => {
    const builder = new PartRowBuilder({
      orgId: "org_1",
      threadId: "thread_1",
      runId: "thread_1",
      baseTimeMs: 1_700_000_000_000,
    });
    const rows = builder.emitFinal({
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "hi" }],
      metadata: {
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        codingAgentSessionId: "sess-1",
        codingAgentProvider: "claude-code",
      },
    } as Parameters<typeof builder.emitFinal>[0] & { metadata?: unknown });
    const finish = rows.find((r) => r.kind === "finish");
    expect(finish?.metadata).toMatchObject({ codingAgentSessionId: "sess-1" });
  });

  it("a FRESH assistant emitter yields the SAME row ids as the projector (dedupes); a SHARED one diverges (the duplicate bug)", () => {
    // The live path and the durable projector both persist the SAME assistant
    // message. Dedup depends on identical row ids (`runId:messageId:seq`). The
    // projector always uses a fresh emitter (assistant-only → seq 0,1,2). If the
    // live path reuses the emitter that already wrote the user message (seq
    // 0,1), the assistant seqs shift to 2,3,4 → ids diverge → ON CONFLICT can't
    // dedupe → the message persists twice. The live path MUST use a fresh
    // emitter too.
    const shared = { orgId: "org_1", threadId: "thread_1", runId: "thread_1" };
    const assistant = {
      id: "assistant_1",
      role: "assistant" as const,
      parts: [
        { type: "reasoning", state: "done", text: "think" },
        { type: "text", state: "done", text: "answer" },
      ],
    };

    // Projector: fresh emitter, assistant only.
    const projector = new PartRowBuilder({ ...shared, baseTimeMs: 1000 });
    const projectorIds = projector.emitFinal(assistant).map((r) => r.id);

    // Live FRESH (the fix): identical row ids → dedupe.
    const liveFresh = new PartRowBuilder({ ...shared, baseTimeMs: 5000 });
    expect(liveFresh.emitFinal(assistant).map((r) => r.id)).toEqual(
      projectorIds,
    );

    // Live SHARED with the user message (the bug): assistant seqs shift → ids
    // diverge from the projector → both copies survive ON CONFLICT.
    const liveShared = new PartRowBuilder({ ...shared, baseTimeMs: 5000 });
    liveShared.acknowledge(
      liveShared.emitUserMessage({
        id: "user_1",
        role: "user",
        parts: [{ type: "text", text: "q" }],
      }),
    );
    expect(liveShared.emitFinal(assistant).map((r) => r.id)).not.toEqual(
      projectorIds,
    );
  });
});
