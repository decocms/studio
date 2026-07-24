import { describe, expect, test } from "bun:test";
import {
  extractTextFromOutput,
  getToolPartErrorText,
  safeStringify,
} from "./utils.ts";

describe("extractTextFromOutput", () => {
  test("returns null for null/undefined", () => {
    expect(extractTextFromOutput(null)).toBeNull();
    expect(extractTextFromOutput(undefined)).toBeNull();
  });

  test("returns null for non-object", () => {
    expect(extractTextFromOutput("string")).toBeNull();
    expect(extractTextFromOutput(42)).toBeNull();
  });

  test("returns null when parts is missing", () => {
    expect(extractTextFromOutput({})).toBeNull();
  });

  test("returns null when parts is empty array", () => {
    expect(extractTextFromOutput({ parts: [] })).toBeNull();
  });

  test("returns null when parts is not array", () => {
    expect(extractTextFromOutput({ parts: "not-array" })).toBeNull();
  });

  test("returns null when no text parts", () => {
    expect(
      extractTextFromOutput({ parts: [{ type: "tool-call" }] }),
    ).toBeNull();
  });

  test("returns text for single text part", () => {
    const output = { parts: [{ type: "text", text: "Hello" }] };
    expect(extractTextFromOutput(output)).toBe("Hello");
  });

  test("joins multiple text parts with double newline", () => {
    const output = {
      parts: [
        { type: "text", text: "First" },
        { type: "tool-call" },
        { type: "text", text: "Second" },
      ],
    };
    expect(extractTextFromOutput(output)).toBe("First\n\nSecond");
  });

  test("skips parts with non-string text", () => {
    const output = {
      parts: [
        { type: "text", text: 42 },
        { type: "text", text: "Valid" },
      ],
    };
    expect(extractTextFromOutput(output)).toBe("Valid");
  });

  test("handles reasoning parts", () => {
    const output = {
      parts: [{ type: "reasoning", text: "Thinking about the problem..." }],
    };
    expect(extractTextFromOutput(output)).toBe(
      "## Reasoning\nThinking about the problem...",
    );
  });

  test("handles source-url parts", () => {
    const output = {
      parts: [{ type: "source-url", url: "https://example.com" }],
    };
    expect(extractTextFromOutput(output)).toBe(
      "## Source URL\nhttps://example.com",
    );
  });

  test("handles source-document parts", () => {
    const output = {
      parts: [{ type: "source-document", title: "API Documentation" }],
    };
    expect(extractTextFromOutput(output)).toBe(
      "## Source Document\nAPI Documentation",
    );
  });

  test("handles file parts with filename", () => {
    const output = {
      parts: [
        { type: "file", filename: "report.pdf", url: "https://example.com" },
      ],
    };
    expect(extractTextFromOutput(output)).toBe("## File\nreport.pdf");
  });

  test("handles file parts with only url", () => {
    const output = {
      parts: [{ type: "file", url: "https://example.com/file.pdf" }],
    };
    expect(extractTextFromOutput(output)).toBe(
      "## File\nhttps://example.com/file.pdf",
    );
  });

  test("ignores step-start parts", () => {
    const output = {
      parts: [
        { type: "text", text: "Before" },
        { type: "step-start" },
        { type: "text", text: "After" },
      ],
    };
    expect(extractTextFromOutput(output)).toBe("Before\n\nAfter");
  });

  test("handles tool-call with input-streaming state", () => {
    const output = {
      parts: [
        {
          type: "tool-call-read",
          state: "input-streaming",
        },
      ],
    };
    expect(extractTextFromOutput(output)).toBe(
      "## call-read\nInput streaming...",
    );
  });

  test("handles tool-call with input-available state", () => {
    const output = {
      parts: [
        {
          type: "tool-call-write",
          state: "input-available",
          input: { path: "/test/file.txt" },
        },
      ],
    };
    expect(extractTextFromOutput(output)).toContain("## call-write");
    expect(extractTextFromOutput(output)).toContain("### Input");
    expect(extractTextFromOutput(output)).toContain('{"path":"/test/file');
  });

  test("handles tool-call with approval-requested state", () => {
    const output = {
      parts: [
        {
          type: "tool-call-bash",
          state: "approval-requested",
          input: { command: "ls" },
        },
      ],
    };
    expect(extractTextFromOutput(output)).toBe(
      "## call-bash\nApproval requested...",
    );
  });

  test("handles tool-call with approval-responded state", () => {
    const output = {
      parts: [
        {
          type: "tool-call-bash",
          state: "approval-responded",
          input: { command: "ls" },
        },
      ],
    };
    expect(extractTextFromOutput(output)).toBe(
      "## call-bash\nApproval responded...",
    );
  });

  test("handles tool-call with output-available state and output", () => {
    const output = {
      parts: [
        {
          type: "tool-call-read",
          state: "output-available",
          input: { path: "/test.txt" },
          output: "File contents here",
        },
      ],
    };
    const result = extractTextFromOutput(output);
    expect(result).toContain("## call-read");
    expect(result).toContain('Input: {"path":"/test.txt"}...');
    expect(result).toContain('Output: "File contents here"...');
  });

  test("handles tool-call with output-available state but no output", () => {
    const output = {
      parts: [
        {
          type: "tool-call-read",
          state: "output-available",
          input: { path: "/test.txt" },
          output: null,
        },
      ],
    };
    const result = extractTextFromOutput(output);
    expect(result).toContain("## call-read");
    expect(result).toContain("Tool responded with no output");
  });

  test("handles tool-call with output-error state with errorText", () => {
    const output = {
      parts: [
        {
          type: "tool-call-bash",
          state: "output-error",
          input: { command: "invalid" },
          errorText: "Command not found",
        },
      ],
    };
    const result = extractTextFromOutput(output);
    expect(result).toContain("## call-bash");
    expect(result).toContain('Input: {"command":"invalid"}...');
    expect(result).toContain("Error: Command not found");
  });

  test("handles tool-call with output-error state without errorText", () => {
    const output = {
      parts: [
        {
          type: "tool-call-bash",
          state: "output-error",
          input: { command: "invalid" },
        },
      ],
    };
    const result = extractTextFromOutput(output);
    expect(result).toContain("## call-bash");
    expect(result).toContain("Tool responded with an error");
  });

  test("handles tool-call with output-denied state", () => {
    const output = {
      parts: [
        {
          type: "tool-call-bash",
          state: "output-denied",
          input: { command: "rm -rf /" },
        },
      ],
    };
    const result = extractTextFromOutput(output);
    expect(result).toContain("## call-bash");
    expect(result).toContain("Tool execution was denied");
  });

  test("handles dynamic-tool parts", () => {
    const output = {
      parts: [
        {
          type: "dynamic-tool",
          toolName: "custom_tool",
          state: "output-available",
          input: { param: "value" },
          output: { result: "success" },
        },
      ],
    };
    const result = extractTextFromOutput(output);
    expect(result).toContain("## custom_tool");
    expect(result).toContain("Input:");
    expect(result).toContain("Output:");
  });

  test("handles complex mixed parts", () => {
    const output = {
      parts: [
        { type: "text", text: "Starting task" },
        { type: "reasoning", text: "Need to read file first" },
        {
          type: "tool-call-read",
          state: "output-available",
          input: { path: "/test.txt" },
          output: "content",
        },
        { type: "text", text: "Task complete" },
      ],
    };
    const result = extractTextFromOutput(output);
    expect(result).toContain("Starting task");
    expect(result).toContain("## Reasoning\nNeed to read file first");
    expect(result).toContain("## call-read");
    expect(result).toContain("Task complete");
    // Ensure parts are joined with double newlines
    expect(result?.split("\n\n").length).toBeGreaterThan(1);
  });

  test("does not add trailing newline", () => {
    const output = {
      parts: [
        { type: "text", text: "First" },
        { type: "text", text: "Second" },
      ],
    };
    const result = extractTextFromOutput(output);
    expect(result).toBe("First\n\nSecond");
    expect(result?.endsWith("\n\n")).toBe(false);
  });

  test("handles tool-call with circular reference in input", () => {
    const circular: any = { prop: "value" };
    circular.self = circular;

    const output = {
      parts: [
        {
          type: "tool-call-bash",
          state: "output-available",
          input: circular,
          output: "success",
        },
      ],
    };
    const result = extractTextFromOutput(output);
    expect(result).toContain("## call-bash");
    expect(result).toContain("[Non-serializable value]");
  });

  test("handles tool-call with undefined input", () => {
    const output = {
      parts: [
        {
          type: "tool-call-bash",
          state: "output-available",
          input: undefined,
          output: "success",
        },
      ],
    };
    const result = extractTextFromOutput(output);
    expect(result).toContain("## call-bash");
    expect(result).toContain("[No input]");
  });

  test("handles tool-call with null input", () => {
    const output = {
      parts: [
        {
          type: "tool-call-bash",
          state: "output-available",
          input: null,
          output: "success",
        },
      ],
    };
    const result = extractTextFromOutput(output);
    expect(result).toContain("## call-bash");
    expect(result).toContain("[No input]");
  });

  test("handles tool-call with BigInt in output", () => {
    const output = {
      parts: [
        {
          type: "tool-call-read",
          state: "output-available",
          input: { id: 123 },
          output: { value: BigInt(9007199254740991) },
        },
      ],
    };
    const result = extractTextFromOutput(output);
    expect(result).toContain("## call-read");
    expect(result).toContain("[Non-serializable value]");
  });

  test("handles tool-call with function in input", () => {
    const output = {
      parts: [
        {
          type: "tool-call-test",
          state: "output-available",
          input: { callback: () => {} },
          output: "done",
        },
      ],
    };
    const result = extractTextFromOutput(output);
    expect(result).toContain("## call-test");
    // Functions are silently omitted by JSON.stringify
    expect(result).toContain("Input:");
  });
});

describe("safeStringify", () => {
  test("returns empty string for null", () => {
    expect(safeStringify(null)).toBe("");
  });

  test("returns empty string for undefined", () => {
    expect(safeStringify(undefined)).toBe("");
  });

  test("stringifies normal objects", () => {
    expect(safeStringify({ key: "value" })).toBe('{"key":"value"}');
  });

  test("stringifies arrays", () => {
    expect(safeStringify([1, 2, 3])).toBe("[1,2,3]");
  });

  test("stringifies strings", () => {
    expect(safeStringify("hello")).toBe('"hello"');
  });

  test("stringifies numbers", () => {
    expect(safeStringify(42)).toBe("42");
  });

  test("stringifies booleans", () => {
    expect(safeStringify(true)).toBe("true");
  });

  test("returns fallback for circular references", () => {
    const circular: any = { prop: "value" };
    circular.self = circular;
    expect(safeStringify(circular)).toBe("[Non-serializable value]");
  });

  test("returns fallback for BigInt", () => {
    expect(safeStringify(BigInt(123))).toBe("[Non-serializable value]");
  });

  test("handles objects with undefined properties", () => {
    expect(safeStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("handles objects with function properties", () => {
    expect(safeStringify({ a: 1, fn: () => {} })).toBe('{"a":1}');
  });

  test("handles nested objects", () => {
    expect(safeStringify({ a: { b: { c: 1 } } })).toBe('{"a":{"b":{"c":1}}}');
  });

  test("handles Date objects", () => {
    const date = new Date("2024-01-01T00:00:00.000Z");
    expect(safeStringify(date)).toBe('"2024-01-01T00:00:00.000Z"');
  });
});

describe("getToolPartErrorText", () => {
  test("returns errorText when present and string", () => {
    expect(getToolPartErrorText({ errorText: "Oops" })).toBe("Oops");
  });

  test("returns fallback when errorText missing", () => {
    expect(getToolPartErrorText({})).toBe("An unknown error occurred");
  });

  test("returns custom fallback", () => {
    expect(getToolPartErrorText({}, "Subtask failed")).toBe("Subtask failed");
  });

  test("returns fallback when errorText is not a string", () => {
    expect(getToolPartErrorText({ errorText: 42 })).toBe(
      "An unknown error occurred",
    );
  });
});
