import { describe, expect, it } from "bun:test";
import { SUGGEST_TASK } from "./suggest-task";
import { chatToolContext } from "./test-helpers";

describe("suggest_task", () => {
  // Claude Code cannot take the user's answer as this call's result.
  it("returns at once, telling the model the card is shown", async () => {
    const result = await SUGGEST_TASK.handler(
      { title: "Add dark mode", summary: "A toggle in settings." },
      chatToolContext(),
    );
    expect(result).toEqual({ shown: true });
    expect(SUGGEST_TASK.modelSummary?.(result)).toMatch(/next message/);
  });

  it("rejects an empty title", () => {
    expect(
      SUGGEST_TASK.inputSchema.safeParse({ title: "", summary: "x" }).success,
    ).toBe(false);
  });
});
