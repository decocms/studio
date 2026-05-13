import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { stripTodoWriteParts } from "./strip-todo-writes";

function assistantWithToolCalls(
  calls: Array<{ toolCallId: string; toolName: string; input?: unknown }>,
): ModelMessage {
  return {
    role: "assistant",
    content: calls.map((c) => ({
      type: "tool-call" as const,
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input ?? {},
    })),
  } as ModelMessage;
}

function toolResults(
  results: Array<{ toolCallId: string; toolName: string; output?: unknown }>,
): ModelMessage {
  return {
    role: "tool",
    content: results.map((r) => ({
      type: "tool-result" as const,
      toolCallId: r.toolCallId,
      toolName: r.toolName,
      output: r.output ?? { type: "json", value: { ok: true } },
    })),
  } as ModelMessage;
}

describe("stripTodoWriteParts", () => {
  test("returns empty array unchanged", () => {
    expect(stripTodoWriteParts([])).toEqual([]);
  });

  test("returns unchanged when no todo_write calls", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" } as ModelMessage,
      assistantWithToolCalls([
        { toolCallId: "a", toolName: "user_ask", input: { prompt: "?" } },
      ]),
      toolResults([{ toolCallId: "a", toolName: "user_ask" }]),
    ];
    expect(stripTodoWriteParts(messages)).toEqual(messages);
  });

  test("removes a todo_write call and its matching result", () => {
    const messages: ModelMessage[] = [
      assistantWithToolCalls([
        {
          toolCallId: "tw1",
          toolName: "todo_write",
          input: {
            todos: [{ content: "x", status: "pending", activeForm: "doing x" }],
          },
        },
      ]),
      toolResults([
        {
          toolCallId: "tw1",
          toolName: "todo_write",
          output: { type: "json", value: { ok: true, count: 1 } },
        },
      ]),
    ];
    const result = stripTodoWriteParts(messages);
    expect(result[0]).toMatchObject({ role: "assistant", content: [] });
    expect(result[1]).toMatchObject({ role: "tool", content: [] });
  });

  test("removes todo_write parts while preserving other tool calls in the same message", () => {
    const messages: ModelMessage[] = [
      assistantWithToolCalls([
        { toolCallId: "ua", toolName: "user_ask", input: { prompt: "?" } },
        {
          toolCallId: "tw1",
          toolName: "todo_write",
          input: {
            todos: [{ content: "x", status: "pending", activeForm: "doing x" }],
          },
        },
      ]),
      toolResults([
        { toolCallId: "ua", toolName: "user_ask" },
        { toolCallId: "tw1", toolName: "todo_write" },
      ]),
    ];
    const result = stripTodoWriteParts(messages);
    const assistantContent = (result[0] as { content: unknown[] }).content;
    expect(assistantContent).toHaveLength(1);
    expect(assistantContent[0]).toMatchObject({ toolName: "user_ask" });

    const toolContent = (result[1] as { content: unknown[] }).content;
    expect(toolContent).toHaveLength(1);
    expect(toolContent[0]).toMatchObject({ toolName: "user_ask" });
  });

  test("strips multiple todo_write revisions across multiple messages", () => {
    const messages: ModelMessage[] = [
      assistantWithToolCalls([{ toolCallId: "tw1", toolName: "todo_write" }]),
      toolResults([{ toolCallId: "tw1", toolName: "todo_write" }]),
      { role: "user", content: "next" } as ModelMessage,
      assistantWithToolCalls([{ toolCallId: "tw2", toolName: "todo_write" }]),
      toolResults([{ toolCallId: "tw2", toolName: "todo_write" }]),
    ];
    const result = stripTodoWriteParts(messages);
    expect((result[0] as { content: unknown[] }).content).toHaveLength(0);
    expect((result[3] as { content: unknown[] }).content).toHaveLength(0);
    expect((result[1] as { content: unknown[] }).content).toHaveLength(0);
    expect((result[4] as { content: unknown[] }).content).toHaveLength(0);
    expect(result[2]).toMatchObject({ role: "user", content: "next" });
  });

  test("strips an orphan todo_write tool-result (defensive)", () => {
    const messages: ModelMessage[] = [
      toolResults([{ toolCallId: "tw_orphan", toolName: "todo_write" }]),
    ];
    expect(
      (stripTodoWriteParts(messages)[0] as { content: unknown[] }).content,
    ).toHaveLength(0);
  });

  test("preserves text parts on assistant messages while stripping tool-call", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text" as const, text: "ok, here's the plan:" },
          {
            type: "tool-call" as const,
            toolCallId: "tw1",
            toolName: "todo_write",
            input: { todos: [] },
          },
        ],
      } as ModelMessage,
      toolResults([{ toolCallId: "tw1", toolName: "todo_write" }]),
    ];
    const result = stripTodoWriteParts(messages);
    const assistantContent = (result[0] as { content: unknown[] }).content;
    expect(assistantContent).toHaveLength(1);
    expect(assistantContent[0]).toMatchObject({
      type: "text",
      text: "ok, here's the plan:",
    });
  });

  test("returns a new array — does not mutate input", () => {
    const original: ModelMessage[] = [
      assistantWithToolCalls([{ toolCallId: "tw1", toolName: "todo_write" }]),
    ];
    const snapshot = JSON.parse(JSON.stringify(original));
    stripTodoWriteParts(original);
    expect(original).toEqual(snapshot);
  });

  test("ignores non-array string content (user messages)", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" } as ModelMessage,
    ];
    expect(stripTodoWriteParts(messages)).toEqual(messages);
  });
});
