import { describe, expect, test } from "bun:test";
import { extractToolJson } from "./extract-tool-json";

describe("extractToolJson", () => {
  test("returns null for null/undefined input", () => {
    expect(extractToolJson(null)).toBeNull();
    expect(extractToolJson(undefined)).toBeNull();
  });

  test("reads parsed value from structuredContent when present", () => {
    const r = { structuredContent: { a: 1 } };
    expect(extractToolJson<{ a: number }>(r)).toEqual({ a: 1 });
  });

  test("parses JSON from content[0].text when structuredContent is absent", () => {
    const r = { content: [{ type: "text", text: '{"a":2}' }] };
    expect(extractToolJson<{ a: number }>(r)).toEqual({ a: 2 });
  });

  test("returns null when content[0].text is not valid JSON", () => {
    const r = { content: [{ type: "text", text: "not json" }] };
    expect(extractToolJson(r)).toBeNull();
  });

  test("returns null when result is an object without either field", () => {
    expect(extractToolJson({ foo: "bar" })).toBeNull();
  });

  test("structuredContent wins over content[0].text when both present", () => {
    const r = {
      structuredContent: { from: "structured" },
      content: [{ type: "text", text: '{"from":"text"}' }],
    };
    expect(extractToolJson<{ from: string }>(r)).toEqual({
      from: "structured",
    });
  });
});
