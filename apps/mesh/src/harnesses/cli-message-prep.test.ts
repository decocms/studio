import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "./types";
import { prepCliMessages } from "./cli-message-prep";

describe("prepCliMessages", () => {
  test("converts a simple text UIMessage to a ModelMessage with content", async () => {
    const ui: ChatMessage[] = [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      } as ChatMessage,
    ];
    const out = await prepCliMessages(ui);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("user");
    // The point of the conversion: model messages have `content`, not `parts`.
    expect("content" in out[0]!).toBe(true);
    expect("parts" in out[0]!).toBe(false);
    // The text payload survives.
    const content = out[0]!.content;
    if (typeof content === "string") {
      expect(content).toBe("hello");
    } else {
      expect(content).toEqual([{ type: "text", text: "hello" }]);
    }
  });

  test("preserves multi-message order", async () => {
    const ui: ChatMessage[] = [
      {
        id: "a",
        role: "user",
        parts: [{ type: "text", text: "1" }],
      } as ChatMessage,
      {
        id: "b",
        role: "assistant",
        parts: [{ type: "text", text: "2" }],
      } as ChatMessage,
      {
        id: "c",
        role: "user",
        parts: [{ type: "text", text: "3" }],
      } as ChatMessage,
    ];
    const out = await prepCliMessages(ui);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  test("ignoreIncompleteToolCalls true: drops tool parts in input-available state", async () => {
    // The decopilot pipeline uses the same flag (conversation.ts:164-167).
    // SDK behavior (ai/dist/index.mjs:8311-8320): tool parts with state
    // `input-streaming` or `input-available` get filtered out of the
    // assistant message's parts before conversion. The remaining text
    // part still converts.
    const ui: ChatMessage[] = [
      {
        id: "x",
        role: "assistant",
        parts: [
          { type: "text", text: "thinking..." },
          {
            type: "tool-test_tool",
            toolCallId: "tc1",
            state: "input-available",
            input: { foo: "bar" },
          },
        ],
      } as ChatMessage,
    ];
    // The key assertion: conversion does NOT throw.
    const out = await prepCliMessages(ui);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("assistant");
    // The assistant message converted; the incomplete tool call was
    // stripped (left only the text part).
    const content = out[0]!.content;
    if (Array.isArray(content)) {
      // No tool-call parts should remain.
      expect(content.some((p) => p.type === "tool-call")).toBe(false);
      // The text part survived.
      expect(content.some((p) => p.type === "text")).toBe(true);
    }
  });

  test("empty array returns empty array", async () => {
    const out = await prepCliMessages([]);
    expect(out).toEqual([]);
  });

  test("system message converts to a system ModelMessage", async () => {
    const ui: ChatMessage[] = [
      {
        id: "s1",
        role: "system",
        parts: [{ type: "text", text: "You are a helpful assistant." }],
      } as ChatMessage,
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Hi" }],
      } as ChatMessage,
    ];
    const out = await prepCliMessages(ui);
    expect(out.map((m) => m.role)).toEqual(["system", "user"]);
    expect(out[0]!.content).toBe("You are a helpful assistant.");
  });
});
