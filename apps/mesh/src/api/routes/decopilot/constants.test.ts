import { describe, expect, test } from "bun:test";
import { buildTodoWritePrompt } from "./constants";

describe("buildTodoWritePrompt", () => {
  test("mentions the tool name", () => {
    expect(buildTodoWritePrompt()).toContain("todo_write");
  });

  test("specifies the 3+ step threshold", () => {
    expect(buildTodoWritePrompt()).toMatch(/3\+|three or more/i);
  });

  test("specifies the single-in-progress constraint", () => {
    expect(buildTodoWritePrompt()).toMatch(/one .* in_progress|exactly one/i);
  });

  test("explains the full-list rewrite semantics", () => {
    expect(buildTodoWritePrompt()).toMatch(
      /rewrite|replace|full list|entire list/i,
    );
  });
});
