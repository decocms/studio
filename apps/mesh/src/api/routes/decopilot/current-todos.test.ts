import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { getCurrentTodos } from "./current-todos";
import type { Todo } from "./built-in-tools/todo-write";

function makeAssistantMessage(parts: unknown[]): UIMessage {
  return { id: "m", role: "assistant", parts } as unknown as UIMessage;
}

function todoWritePart(todos: Todo[], state = "output-available") {
  return {
    type: "tool-todo_write",
    state,
    input: { todos },
    output: { ok: true, count: todos.length },
    toolCallId: "tc",
  };
}

describe("getCurrentTodos", () => {
  test("returns [] when no todo_write call exists", () => {
    const messages = [makeAssistantMessage([{ type: "text", text: "hello" }])];
    expect(getCurrentTodos(messages)).toEqual([]);
  });

  test("returns the todos from the only todo_write call", () => {
    const todos: Todo[] = [
      { content: "a", status: "pending", activeForm: "doing a" },
    ];
    const messages = [makeAssistantMessage([todoWritePart(todos)])];
    expect(getCurrentTodos(messages)).toEqual(todos);
  });

  test("returns the LATEST todo_write call when multiple exist", () => {
    const older: Todo[] = [
      { content: "old", status: "completed", activeForm: "doing old" },
    ];
    const newer: Todo[] = [
      { content: "new", status: "in_progress", activeForm: "doing new" },
    ];
    const messages = [
      makeAssistantMessage([todoWritePart(older)]),
      makeAssistantMessage([{ type: "text", text: "thinking..." }]),
      makeAssistantMessage([todoWritePart(newer)]),
    ];
    expect(getCurrentTodos(messages)).toEqual(newer);
  });

  test("accepts input-available state (output not yet flushed)", () => {
    const todos: Todo[] = [
      { content: "x", status: "pending", activeForm: "doing x" },
    ];
    const messages = [
      makeAssistantMessage([todoWritePart(todos, "input-available")]),
    ];
    expect(getCurrentTodos(messages)).toEqual(todos);
  });

  test("ignores non-todo_write tool parts", () => {
    const messages = [
      makeAssistantMessage([
        {
          type: "tool-user_ask",
          state: "output-available",
          input: { prompt: "?", type: "text" },
        },
      ]),
    ];
    expect(getCurrentTodos(messages)).toEqual([]);
  });

  test("ignores user messages", () => {
    const todos: Todo[] = [
      { content: "x", status: "pending", activeForm: "doing x" },
    ];
    const messages = [
      // user "messages" can never have tool parts, but guard anyway
      {
        id: "u",
        role: "user",
        parts: [todoWritePart(todos)],
      } as unknown as UIMessage,
    ];
    expect(getCurrentTodos(messages)).toEqual([]);
  });

  test("returns [] when input fails schema validation", () => {
    const messages = [
      makeAssistantMessage([
        {
          type: "tool-todo_write",
          state: "output-available",
          input: {
            todos: [{ content: "", status: "pending", activeForm: "" }],
          },
          toolCallId: "tc",
        },
      ]),
    ];
    // empty content fails min(1)
    expect(getCurrentTodos(messages)).toEqual([]);
  });
});
