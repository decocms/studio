import { describe, expect, test } from "bun:test";
import { answerPrompt, toolOutputAnswer } from "./tool-answer";

describe("toolOutputAnswer", () => {
  test("reads the answer a message carries", () => {
    expect(
      toolOutputAnswer({
        created_at: "2026-10-07T00:00:00.000Z",
        toolOutput: { toolCallId: "call-1", output: { response: "Red" } },
      }),
    ).toEqual({ toolCallId: "call-1", output: { response: "Red" } });
  });

  test("an ordinary or malformed message carries none", () => {
    expect(toolOutputAnswer(undefined)).toBeNull();
    expect(toolOutputAnswer({ created_at: "x" })).toBeNull();
    expect(toolOutputAnswer({ toolOutput: { toolCallId: "" } })).toBeNull();
    expect(toolOutputAnswer({ toolOutput: "call-1" })).toBeNull();
  });
});

describe("answerPrompt", () => {
  test("a user_ask answer names its question", () => {
    expect(
      answerPrompt({
        type: "tool-user_ask",
        input: { prompt: "Which color?", type: "choice" },
        output: { response: "Red" },
      }),
    ).toBe('Answer to "Which color?": Red');
  });

  test("a suggest_task answer names the task", () => {
    expect(
      answerPrompt({
        type: "tool-suggest_task",
        input: { title: "Add dark mode", summary: "s" },
        output: { accepted: false },
      }),
    ).toBe('Answer to "Create the task "Add dark mode"?": No');
  });

  test("an output with no known field is passed on as JSON", () => {
    expect(answerPrompt({ type: "tool-x", output: { picked: 2 } })).toBe(
      '{"picked":2}',
    );
  });
});
