import { describe, expect, test } from "bun:test";
import { extractSubtaskResponse } from "./subtask.tsx";

describe("extractSubtaskResponse", () => {
  describe("new shape: { text, error, finishReason }", () => {
    test("returns text on normal completion", () => {
      expect(
        extractSubtaskResponse({
          text: "Hello world",
          error: undefined,
          finishReason: "stop",
        }),
      ).toBe("Hello world");
    });

    test("trims whitespace from text", () => {
      expect(
        extractSubtaskResponse({
          text: "  Hello world  \n",
          finishReason: "stop",
        }),
      ).toBe("Hello world");
    });

    test("prefixes step-limit notice when finishReason=length and text present", () => {
      const result = extractSubtaskResponse({
        text: "Partial result here",
        finishReason: "length",
      });
      expect(result).toContain("hit step limit");
      expect(result).toContain("Partial result here");
    });

    test("returns step-limit notice when finishReason=length and text empty", () => {
      const result = extractSubtaskResponse({
        text: "",
        finishReason: "length",
      });
      expect(result).toContain("hit step limit");
      expect(result).toContain("ran out of steps");
    });

    test("returns error message when error present", () => {
      expect(
        extractSubtaskResponse({
          text: "",
          error: "context overflow",
          finishReason: "error",
        }),
      ).toBe("Subtask failed: context overflow");
    });

    test("error takes precedence over text", () => {
      expect(
        extractSubtaskResponse({
          text: "some text",
          error: "fatal",
          finishReason: "error",
        }),
      ).toBe("Subtask failed: fatal");
    });

    test("returns no-output sentinel when text empty and no error/limit", () => {
      expect(
        extractSubtaskResponse({
          text: "",
          finishReason: "stop",
        }),
      ).toBe("Subtask completed (no output).");
    });

    test("recognises shape when only `error` field present", () => {
      expect(extractSubtaskResponse({ error: "boom" })).toBe(
        "Subtask failed: boom",
      );
    });

    test("recognises shape when only `finishReason` field present (no text)", () => {
      expect(extractSubtaskResponse({ finishReason: "stop" })).toBe(
        "Subtask completed (no output).",
      );
    });
  });

  describe("legacy UIMessage fallback", () => {
    test("extracts text from a UIMessage with parts", () => {
      expect(
        extractSubtaskResponse({
          parts: [{ type: "text", text: "Legacy hello" }],
        }),
      ).toBe("Legacy hello");
    });

    test("returns null for an empty object (no shape match)", () => {
      expect(extractSubtaskResponse({})).toBeNull();
    });
  });

  describe("invalid inputs", () => {
    test("returns null for null/undefined", () => {
      expect(extractSubtaskResponse(null)).toBeNull();
      expect(extractSubtaskResponse(undefined)).toBeNull();
    });

    test("returns null for non-object", () => {
      expect(extractSubtaskResponse("a string")).toBeNull();
      expect(extractSubtaskResponse(42)).toBeNull();
    });

    test("returns null for arrays", () => {
      expect(extractSubtaskResponse(["a", "b"])).toBeNull();
    });

    test("ignores fields with wrong types (no new-shape hit, falls back)", () => {
      // text is a number, no other recognized strings → falls back to
      // extractTextFromOutput, which returns null for objects without parts[].
      expect(extractSubtaskResponse({ text: 42 })).toBeNull();
    });
  });
});
