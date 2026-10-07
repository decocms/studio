import { describe, expect, test } from "bun:test";
import { isSuggestTaskPending } from "./is-suggest-task-pending";

describe("isSuggestTaskPending", () => {
  const part = (state: string, output?: unknown) => ({
    type: "tool-suggest_task",
    state,
    output,
  });

  test("an offer waits until the user stores a decision", () => {
    expect(isSuggestTaskPending(part("input-available"))).toBe(true);
    expect(
      isSuggestTaskPending(part("output-available", "shown to the user")),
    ).toBe(true);
    expect(
      isSuggestTaskPending(part("output-available", { accepted: false })),
    ).toBe(false);
    expect(isSuggestTaskPending(part("output-error"))).toBe(false);
    expect(
      isSuggestTaskPending({ type: "tool-user_ask", state: "input-available" }),
    ).toBe(false);
  });
});
