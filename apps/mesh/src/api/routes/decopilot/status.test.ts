import { describe, expect, test } from "bun:test";
import { resolveThreadStatus } from "./status";

describe("resolveThreadStatus", () => {
  test("stop with no text -> completed", () => {
    expect(resolveThreadStatus("stop", [])).toBe("completed");
  });

  test("stop with statement -> completed", () => {
    const parts = [{ type: "text", text: "Here is the answer." }];
    expect(resolveThreadStatus("stop", parts)).toBe("completed");
  });

  test("stop with question -> requires_action", () => {
    const parts = [
      { type: "text", text: "Here is the answer." },
      { type: "text", text: "Does that help?" },
    ];
    expect(resolveThreadStatus("stop", parts)).toBe("requires_action");
  });

  test("stop with question mark only inside URL -> completed", () => {
    const parts = [
      { type: "text", text: "Check out https://example.com/page?foo=bar for more info." },
    ];
    expect(resolveThreadStatus("stop", parts)).toBe("completed");
  });

  test("stop with question and URL -> requires_action", () => {
    const parts = [
      { type: "text", text: "See https://example.com/page?q=1 — does this help?" },
    ];
    expect(resolveThreadStatus("stop", parts)).toBe("requires_action");
  });

  test("tool-calls without user_ask -> completed", () => {
    const parts = [
      { type: "tool-invocation", toolName: "some_tool", state: "result" },
    ];
    expect(resolveThreadStatus("tool-calls", parts)).toBe("completed");
  });

  test("tool-calls with user_ask input-available -> requires_action", () => {
    const parts = [
      {
        type: "tool-user_ask",
        toolName: "user_ask",
        state: "input-available",
      },
    ];
    expect(resolveThreadStatus("tool-calls", parts)).toBe("requires_action");
  });

  test("tool-calls with user_ask output-available -> completed", () => {
    const parts = [
      {
        type: "tool-user_ask",
        toolName: "user_ask",
        state: "output-available",
      },
    ];
    expect(resolveThreadStatus("tool-calls", parts)).toBe("completed");
  });

  test("tool-calls with approval-requested -> requires_action", () => {
    const parts = [
      {
        type: "tool-invocation",
        toolName: "some_tool",
        state: "approval-requested",
      },
    ];
    expect(resolveThreadStatus("tool-calls", parts)).toBe("requires_action");
  });

  test("tool-calls with multiple tools, one approval-requested -> requires_action", () => {
    const parts = [
      {
        type: "tool-invocation",
        toolName: "tool_a",
        state: "output-available",
      },
      {
        type: "tool-invocation",
        toolName: "tool_b",
        state: "approval-requested",
      },
    ];
    expect(resolveThreadStatus("tool-calls", parts)).toBe("requires_action");
  });

  test("tool-calls with approval-requested and user_ask pending -> requires_action", () => {
    const parts = [
      {
        type: "tool-invocation",
        toolName: "some_tool",
        state: "approval-requested",
      },
      {
        type: "tool-user_ask",
        toolName: "user_ask",
        state: "input-available",
      },
    ];
    expect(resolveThreadStatus("tool-calls", parts)).toBe("requires_action");
  });

  test("tool-calls with denied approval -> completed", () => {
    const parts = [
      {
        type: "tool-invocation",
        toolName: "some_tool",
        state: "output-denied",
      },
    ];
    expect(resolveThreadStatus("tool-calls", parts)).toBe("completed");
  });

  test("length -> failed", () => {
    expect(resolveThreadStatus("length", [])).toBe("failed");
  });

  test("error -> failed", () => {
    expect(resolveThreadStatus("error", [])).toBe("failed");
  });

  test("undefined -> failed", () => {
    expect(resolveThreadStatus(undefined, [])).toBe("failed");
  });
});
