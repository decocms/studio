import { describe, expect, test } from "bun:test";
import { todoWriteTool, TodoWriteInputSchema, type Todo } from "./todo-write";

describe("todoWriteTool", () => {
  test("has description, input schema, and execute", () => {
    expect(todoWriteTool.description).toContain("todo");
    expect(todoWriteTool.inputSchema).toBeDefined();
    expect(typeof todoWriteTool.execute).toBe("function");
  });

  test("accepts a well-formed todo list", () => {
    const input = {
      todos: [
        {
          content: "Implement login flow",
          status: "in_progress",
          activeForm: "Implementing login flow",
        },
        {
          content: "Write integration tests",
          status: "pending",
          activeForm: "Writing integration tests",
        },
      ] as Todo[],
    };
    expect(TodoWriteInputSchema.safeParse(input).success).toBe(true);
  });

  test("rejects todos with empty content", () => {
    const input = {
      todos: [{ content: "", status: "pending", activeForm: "Doing" }],
    };
    expect(TodoWriteInputSchema.safeParse(input).success).toBe(false);
  });

  test("rejects unknown status values", () => {
    const input = {
      todos: [{ content: "x", status: "blocked", activeForm: "Doing x" }],
    };
    expect(TodoWriteInputSchema.safeParse(input).success).toBe(false);
  });

  test("accepts an empty todo list (model is clearing it)", () => {
    expect(TodoWriteInputSchema.safeParse({ todos: [] }).success).toBe(true);
  });

  test("description tells the model not to call todo_write to read the list", () => {
    expect(todoWriteTool.description).toMatch(
      /current[- ]?todos|do not call.*to read|always visible/i,
    );
  });

  test("execute returns ok + count", async () => {
    const input = {
      todos: [
        { content: "a", status: "pending" as const, activeForm: "doing a" },
        { content: "b", status: "completed" as const, activeForm: "doing b" },
      ],
    };
    const result = await todoWriteTool.execute!(input, {
      toolCallId: "test",
      messages: [],
      abortSignal: new AbortController().signal,
    } as never);
    expect(result).toEqual({ ok: true, count: 2 });
  });
});
