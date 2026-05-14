import { describe, expect, test } from "bun:test";
import { normalizeMessages } from "./normalize-messages.ts";

describe("normalizeMessages", () => {
  test("wraps a plain-text string as a user message", () => {
    const [first, ...rest] = normalizeMessages("hello world");
    expect(rest).toHaveLength(0);
    expect(first?.role).toBe("user");
    expect(first?.parts).toEqual([{ type: "text", text: "hello world" }]);
  });

  test("parses a JSON-serialized message array", () => {
    const input = JSON.stringify([
      { role: "user", parts: [{ type: "text", text: "hi" }] },
    ]);
    const [first, ...rest] = normalizeMessages(input);
    expect(rest).toHaveLength(0);
    expect(first?.role).toBe("user");
  });

  test("attaches tiptapDoc from the first text part when missing", () => {
    const [first] = normalizeMessages([
      { role: "user", parts: [{ type: "text", text: "do the thing" }] },
    ]);
    const meta = first?.metadata as { tiptapDoc?: unknown } | undefined;
    expect(meta?.tiptapDoc).toBeDefined();
  });

  test("rejects an array containing only system messages", () => {
    expect(() =>
      normalizeMessages([
        { role: "system", parts: [{ type: "text", text: "be helpful" }] },
      ]),
    ).toThrow(/at least one user message/i);
  });

  test("rejects a user message whose only text part is whitespace", () => {
    expect(() =>
      normalizeMessages([
        { role: "user", parts: [{ type: "text", text: "   \n  " }] },
      ]),
    ).toThrow(/at least one user message/i);
  });

  test("rejects a user message with no parts", () => {
    expect(() => normalizeMessages([{ role: "user", parts: [] }])).toThrow(
      /at least one user message/i,
    );
  });

  test("accepts a user message with a file part", () => {
    const result = normalizeMessages([
      {
        role: "user",
        parts: [{ type: "file", url: "data:image/png;base64,AAA" }],
      },
    ]);
    expect(result).toHaveLength(1);
  });

  test("accepts when a user message coexists with system messages", () => {
    const result = normalizeMessages([
      { role: "system", parts: [{ type: "text", text: "be terse" }] },
      { role: "user", parts: [{ type: "text", text: "do it" }] },
    ]);
    expect(result).toHaveLength(2);
  });
});
