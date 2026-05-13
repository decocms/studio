import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { deriveCurrentTodos } from "./derive-current-todos";

describe("deriveCurrentTodos", () => {
  test("empty input → []", () => {
    expect(deriveCurrentTodos([])).toEqual([]);
  });

  test("no tool-todo_write part → []", () => {
    const messages: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      } as unknown as UIMessage,
    ];
    expect(deriveCurrentTodos(messages)).toEqual([]);
  });

  test("input-available state with valid input → parsed todos", () => {
    const todos = [
      { content: "A", activeForm: "Doing A", status: "pending" as const },
    ];
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-todo_write",
            toolCallId: "c1",
            state: "input-available",
            input: { todos },
          },
        ],
      } as unknown as UIMessage,
    ];
    expect(deriveCurrentTodos(messages)).toEqual(todos);
  });

  test("multiple writes → latest valid wins", () => {
    const older = [
      { content: "A", activeForm: "Doing A", status: "pending" as const },
    ];
    const newer = [
      { content: "A", activeForm: "Doing A", status: "completed" as const },
    ];
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-todo_write",
            toolCallId: "c1",
            state: "output-available",
            input: { todos: older },
          },
        ],
      } as unknown as UIMessage,
      {
        id: "a2",
        role: "assistant",
        parts: [
          {
            type: "tool-todo_write",
            toolCallId: "c2",
            state: "input-available",
            input: { todos: newer },
          },
        ],
      } as unknown as UIMessage,
    ];
    expect(deriveCurrentTodos(messages)).toEqual(newer);
  });
});
