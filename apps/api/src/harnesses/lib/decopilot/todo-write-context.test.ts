import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { keepLastTodoWrite } from "./todo-write-context";

describe("keepLastTodoWrite", () => {
  test("empty input → []", () => {
    expect(keepLastTodoWrite([])).toEqual([]);
  });

  test("no todo_write parts → input returned by reference", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    ];
    const out = keepLastTodoWrite(messages);
    expect(out).toBe(messages);
  });

  test("single todo_write call + matching result → preserved", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "planning" },
          {
            type: "tool-call",
            toolCallId: "tw1",
            toolName: "todo_write",
            input: { todos: [] },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tw1",
            toolName: "todo_write",
            output: { type: "json", value: { ok: true, count: 0 } },
          },
        ],
      },
    ];
    const out = keepLastTodoWrite(messages);
    expect((out[0] as { content: unknown[] }).content).toHaveLength(2);
    expect((out[1] as { content: unknown[] }).content).toHaveLength(1);
  });

  test("multiple todo_write calls → only the latest call AND its result survive", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tw1",
            toolName: "todo_write",
            input: { todos: [] },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tw1",
            toolName: "todo_write",
            output: { type: "json", value: { ok: true, count: 0 } },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "step 2" },
          {
            type: "tool-call",
            toolCallId: "tw2",
            toolName: "todo_write",
            input: { todos: [] },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tw2",
            toolName: "todo_write",
            output: { type: "json", value: { ok: true, count: 0 } },
          },
        ],
      },
    ];
    const out = keepLastTodoWrite(messages);
    // First assistant: tw1 call dropped → content empty.
    expect((out[0] as { content: unknown[] }).content).toEqual([]);
    // First tool: tw1 result dropped → content empty.
    expect((out[1] as { content: unknown[] }).content).toEqual([]);
    // Second assistant: text kept, tw2 call kept.
    expect((out[2] as { content: unknown[] }).content).toHaveLength(2);
    // Second tool: tw2 result kept.
    expect((out[3] as { content: unknown[] }).content).toHaveLength(1);
  });

  test("latest todo_write call has no matching result → just the call survives", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tw_orphan",
            toolName: "todo_write",
            input: { todos: [] },
          },
        ],
      },
    ];
    const out = keepLastTodoWrite(messages);
    expect((out[0] as { content: unknown[] }).content).toHaveLength(1);
  });

  test("non-todo_write tool calls and text are untouched", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "running ls" },
          {
            type: "tool-call",
            toolCallId: "b1",
            toolName: "bash",
            input: { command: "ls" },
          },
          {
            type: "tool-call",
            toolCallId: "tw1",
            toolName: "todo_write",
            input: { todos: [] },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "b1",
            toolName: "bash",
            output: { type: "json", value: { stdout: "" } },
          },
          {
            type: "tool-result",
            toolCallId: "tw1",
            toolName: "todo_write",
            output: { type: "json", value: { ok: true, count: 0 } },
          },
        ],
      },
    ];
    const out = keepLastTodoWrite(messages);
    // All parts kept since tw1 is the latest.
    expect((out[0] as { content: unknown[] }).content).toHaveLength(3);
    expect((out[1] as { content: unknown[] }).content).toHaveLength(2);
  });

  test("does not mutate input", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tw1",
            toolName: "todo_write",
            input: { todos: [] },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tw2",
            toolName: "todo_write",
            input: { todos: [] },
          },
        ],
      },
    ];
    const before = JSON.stringify(messages);
    keepLastTodoWrite(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });
});
