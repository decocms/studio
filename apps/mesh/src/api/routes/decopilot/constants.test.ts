import { describe, expect, test } from "bun:test";
import { buildTodoWritePrompt } from "./constants";

describe("buildTodoWritePrompt", () => {
  test("mentions the tool name", () => {
    expect(buildTodoWritePrompt()).toContain("todo_write");
  });

  test("instructs to call it at the start of every multi-step request", () => {
    expect(buildTodoWritePrompt()).toMatch(/multi-step|every multi-step/i);
  });

  test("specifies the single-in-progress constraint", () => {
    expect(buildTodoWritePrompt()).toMatch(/one .* in_progress|exactly one/i);
  });

  test("explains the full-list rewrite semantics", () => {
    expect(buildTodoWritePrompt()).toMatch(
      /rewrite|replace|full list|entire list/i,
    );
  });

  test("tells the model to re-read its last call for current state", () => {
    expect(buildTodoWritePrompt()).toMatch(/most recent|last call|re-read/i);
  });
});
