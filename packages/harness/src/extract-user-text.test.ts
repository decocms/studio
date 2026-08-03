import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { extractUserText } from "./extract-user-text";

describe("extractUserText", () => {
  test("returns the most recent user message when content is a string", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    expect(extractUserText(messages)).toBe("second");
  });

  test("concatenates text parts when content is an array", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "World" },
        ],
      },
    ];
    expect(extractUserText(messages)).toBe("Hello\nWorld");
  });

  test("skips non-text parts (e.g. image, tool-result)", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", image: "data:image/png;base64,abc" } as never,
          { type: "text", text: "describe this" },
        ],
      },
    ];
    expect(extractUserText(messages)).toBe("describe this");
  });

  test("returns empty string when there is no user message", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: "hello" },
      { role: "system", content: "system prompt" },
    ];
    expect(extractUserText(messages)).toBe("");
  });

  test("returns empty string when the messages array is empty", () => {
    expect(extractUserText([])).toBe("");
  });

  test("returns the LAST user message, not the first", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "early turn" },
      { role: "assistant", content: "ack" },
      { role: "user", content: "current turn" },
    ];
    expect(extractUserText(messages)).toBe("current turn");
  });
});
