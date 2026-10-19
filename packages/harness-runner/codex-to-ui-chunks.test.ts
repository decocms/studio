import { describe, expect, test } from "bun:test";
import { CodexChunkTranslator } from "./codex-to-ui-chunks";

describe("Codex chunks", () => {
  test("maps native plan progress to chat todos", () => {
    const chunks = new CodexChunkTranslator().translate("turn/plan/updated", {
      plan: [
        { step: "Read files", status: "completed" },
        { step: "Run tests", status: "inProgress" },
      ],
    });
    expect(chunks[0]).toMatchObject({
      type: "tool-input-available",
      toolName: "todo_write",
      input: {
        todos: [
          {
            content: "Read files",
            activeForm: "Read files",
            status: "completed",
          },
          {
            content: "Run tests",
            activeForm: "Run tests",
            status: "in_progress",
          },
        ],
      },
    });
    expect(chunks[1]).toMatchObject({
      type: "tool-output-available",
      output: { ok: true, count: 2 },
    });
  });
  test("streams text once and closes it before tool steps", () => {
    const translator = new CodexChunkTranslator();
    expect(
      translator.translate("item/agentMessage/delta", {
        itemId: "message_example",
        delta: "Hello",
      }),
    ).toEqual([
      { type: "text-start", id: "message_example" },
      { type: "text-delta", id: "message_example", delta: "Hello" },
    ]);
    expect(
      translator.translate("item/completed", {
        item: { type: "agentMessage", id: "message_example", text: "Hello" },
      }),
    ).toEqual([{ type: "text-end", id: "message_example" }]);
    expect(
      translator.translate("item/completed", {
        item: { type: "agentMessage", id: "message_example", text: "Hello" },
      }),
    ).toEqual([]);
    expect(translator.close()).toEqual([]);
  });

  test("a completed tool without its start still emits input before output", () => {
    const translator = new CodexChunkTranslator();
    const chunks = translator.translate("item/completed", {
      item: {
        id: "call_example",
        type: "mcpToolCall",
        server: "studio",
        tool: "TASK_BOARD_ITEM_LIST",
        arguments: {},
        result: { items: [] },
        status: "completed",
      },
    });
    expect(chunks).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "call_example",
        toolName: "TASK_BOARD_ITEM_LIST",
        input: {},
      },
      {
        type: "tool-output-available",
        toolCallId: "call_example",
        output: { items: [] },
      },
      { type: "finish-step" },
      { type: "start-step" },
    ]);
  });

  test("overlapping tool calls retain their own outputs and errors", () => {
    const translator = new CodexChunkTranslator();
    for (const id of ["call_a", "call_b"])
      translator.translate("item/started", {
        item: {
          id,
          type: "commandExecution",
          command: "bun test",
          cwd: "/repo",
          status: "inProgress",
        },
      });
    expect(
      translator.translate("item/completed", {
        item: {
          id: "call_b",
          type: "commandExecution",
          status: "failed",
          error: "command failed",
        },
      })[0],
    ).toEqual({
      type: "tool-output-error",
      toolCallId: "call_b",
      errorText: "command failed",
    });
    expect(
      translator.translate("item/completed", {
        item: {
          id: "call_a",
          type: "commandExecution",
          status: "completed",
          aggregatedOutput: "ok",
          exitCode: 0,
        },
      })[0],
    ).toEqual({
      type: "tool-output-available",
      toolCallId: "call_a",
      output: { stdout: "ok", exitCode: 0 },
    });
  });

  test("questions and plans wait for a follow-up without inventing an answer", () => {
    const translator = new CodexChunkTranslator();
    expect(
      translator.question({
        itemId: "question_example",
        questions: [
          {
            question: "Which option?",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      }),
    ).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "question_example",
        toolName: "user_ask",
        input: { prompt: "Which option?", type: "choice", options: ["A", "B"] },
      },
    ]);
    expect(translator.awaitingUser).toBeTrue();
    expect(
      new CodexChunkTranslator().translate("item/completed", {
        item: { id: "plan_example", type: "plan", text: "Run tests" },
      }),
    ).toEqual([
      {
        type: "tool-input-available",
        toolCallId: "plan_example",
        toolName: "propose_plan",
        input: { plan: "Run tests" },
      },
    ]);
  });

  test("usage excludes previous turns and accumulates requests within this turn", () => {
    const translator = new CodexChunkTranslator();
    const usage = (
      inputTokens: number,
      outputTokens: number,
      cachedInputTokens: number,
    ) => ({ inputTokens, outputTokens, cachedInputTokens });
    translator.translate("thread/tokenUsage/updated", {
      tokenUsage: { total: usage(150, 30, 80), last: usage(50, 10, 30) },
    });
    expect(translator.usage).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      cachedInputTokens: 30,
      contextTokens: 50,
    });
    translator.translate("thread/tokenUsage/updated", {
      tokenUsage: { total: usage(210, 45, 120), last: usage(60, 15, 40) },
    });
    expect(translator.usage).toEqual({
      inputTokens: 110,
      outputTokens: 25,
      totalTokens: 135,
      cachedInputTokens: 70,
      contextTokens: 60,
    });
  });
});
