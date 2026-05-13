import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { readCurrentTodos, stripTodoWriteParts } from "./todo-write-context";

// -----------------------------
// readCurrentTodos
// -----------------------------

describe("readCurrentTodos", () => {
  test("empty input → []", () => {
    expect(readCurrentTodos([])).toEqual([]);
  });

  test("no assistant todo_write tool-call → []", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    ];
    expect(readCurrentTodos(messages)).toEqual([]);
  });

  test("single todo_write tool-call → parsed todos", () => {
    const todos = [
      {
        content: "Write tests",
        activeForm: "Writing tests",
        status: "pending" as const,
      },
    ];
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "planning" },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "todo_write",
            input: { todos },
          },
        ],
      },
    ];
    expect(readCurrentTodos(messages)).toEqual(todos);
  });

  test("multiple todo_write tool-calls → latest wins", () => {
    const older = [
      { content: "A", activeForm: "Doing A", status: "pending" as const },
    ];
    const newer = [
      { content: "A", activeForm: "Doing A", status: "in_progress" as const },
      { content: "B", activeForm: "Doing B", status: "pending" as const },
    ];
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "todo_write",
            input: { todos: older },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "todo_write",
            input: { todos: newer },
          },
        ],
      },
    ];
    expect(readCurrentTodos(messages)).toEqual(newer);
  });

  test("malformed latest input → fall through to older valid call", () => {
    const older = [
      { content: "A", activeForm: "Doing A", status: "pending" as const },
    ];
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "todo_write",
            input: { todos: older },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "todo_write",
            input: { todos: "not-an-array" },
          },
        ],
      },
    ];
    expect(readCurrentTodos(messages)).toEqual(older);
  });

  test("tool-call on tool message (not assistant) is ignored", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "todo_write",
            output: { type: "json", value: { ok: true, count: 1 } },
          },
        ],
      },
    ];
    expect(readCurrentTodos(messages)).toEqual([]);
  });
});

// -----------------------------
// stripTodoWriteParts — preserved behavior from strip-todo-writes.test.ts
// -----------------------------

describe("stripTodoWriteParts", () => {
  test("empty input → []", () => {
    expect(stripTodoWriteParts([])).toEqual([]);
  });

  test("messages without todo_write are unchanged", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    ];
    expect(stripTodoWriteParts(messages)).toEqual(messages);
  });

  test("removes a todo_write tool-call and its result, leaves siblings intact", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "step 1" },
          {
            type: "tool-call",
            toolCallId: "tw",
            toolName: "todo_write",
            input: { todos: [] },
          },
          {
            type: "tool-call",
            toolCallId: "bash",
            toolName: "bash",
            input: { command: "ls" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tw",
            toolName: "todo_write",
            output: { type: "json", value: { ok: true, count: 0 } },
          },
          {
            type: "tool-result",
            toolCallId: "bash",
            toolName: "bash",
            output: { type: "json", value: { stdout: "" } },
          },
        ],
      },
    ];
    const result = stripTodoWriteParts(messages);
    expect((result[0] as { content: unknown[] }).content).toHaveLength(2);
    expect((result[1] as { content: unknown[] }).content).toHaveLength(1);
  });

  test("does not mutate input", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tw",
            toolName: "todo_write",
            input: { todos: [] },
          },
        ],
      },
    ];
    const before = JSON.stringify(messages);
    stripTodoWriteParts(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });
});
