import { describe, expect, test } from "bun:test";
import {
  assertToolOk,
  extractToolJson,
  toolErrorMessage,
} from "./extract-tool-json";

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

describe("toolErrorMessage / assertToolOk", () => {
  test("returns null for a successful result", () => {
    expect(
      toolErrorMessage({ content: [{ type: "text", text: "{}" }] }),
    ).toBeNull();
    expect(toolErrorMessage(null)).toBeNull();
  });

  test("returns the text payload of an isError result", () => {
    const r = {
      isError: true,
      content: [{ type: "text", text: "unknown method: get_check_runs" }],
    };
    expect(toolErrorMessage(r)).toBe("unknown method: get_check_runs");
  });

  test("falls back to a generic message when isError has no text", () => {
    expect(toolErrorMessage({ isError: true })).toBe(
      "GitHub MCP tool returned an error",
    );
  });

  test("assertToolOk throws on an isError result (so select surfaces it)", () => {
    expect(() =>
      assertToolOk({
        isError: true,
        content: [{ type: "text", text: "403 checks:read required" }],
      }),
    ).toThrow("403 checks:read required");
  });

  test("assertToolOk does not throw on a successful result", () => {
    expect(() =>
      assertToolOk({ content: [{ type: "text", text: '{"check_runs":[]}' }] }),
    ).not.toThrow();
  });
});
