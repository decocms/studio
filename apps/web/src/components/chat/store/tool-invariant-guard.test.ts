import { describe, expect, it } from "bun:test";
import type { UIMessage, UIMessageChunk } from "ai";
import {
  createToolInvariantGuard,
  toolCallIdsInMessage,
} from "./tool-invariant-guard";

const flat = (
  guard: (c: UIMessageChunk) => UIMessageChunk[],
  chunks: UIMessageChunk[],
): UIMessageChunk[] => chunks.flatMap((c) => guard(c));

describe("toolCallIdsInMessage", () => {
  it("collects toolCallIds from tool parts, ignores others", () => {
    const msg = {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "text", text: "hi" },
        {
          type: "tool-web_search",
          toolCallId: "tc_1",
          state: "input-available",
        },
        { type: "tool-foo", toolCallId: "tc_2", state: "output-available" },
      ],
    } as unknown as UIMessage;
    expect(toolCallIdsInMessage(msg)).toEqual(["tc_1", "tc_2"]);
  });

  it("returns [] for undefined or partless messages", () => {
    expect(toolCallIdsInMessage(undefined)).toEqual([]);
    expect(
      toolCallIdsInMessage({ id: "x", role: "user" } as UIMessage),
    ).toEqual([]);
  });
});

describe("createToolInvariantGuard", () => {
  it("passes an input→output pair through untouched", () => {
    const guard = createToolInvariantGuard();
    const out = flat(guard, [
      {
        type: "tool-input-available",
        toolCallId: "tc",
        toolName: "x",
        input: {},
      },
      { type: "tool-output-available", toolCallId: "tc", output: { ok: true } },
    ] as UIMessageChunk[]);
    expect(out.map((c) => c.type)).toEqual([
      "tool-input-available",
      "tool-output-available",
    ]);
  });

  it("synthesizes a tool-input-available before an orphan output", () => {
    const guard = createToolInvariantGuard();
    const out = flat(guard, [
      { type: "tool-output-available", toolCallId: "tc", output: { ok: true } },
    ] as UIMessageChunk[]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      type: "tool-input-available",
      toolCallId: "tc",
      toolName: "unknown",
    });
    expect(out[1]).toMatchObject({ type: "tool-output-available" });
  });

  it("does NOT synthesize when the id was seeded from the message", () => {
    const guard = createToolInvariantGuard(["tc"]);
    const out = flat(guard, [
      { type: "tool-output-available", toolCallId: "tc", output: {} },
    ] as UIMessageChunk[]);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("tool-output-available");
  });

  it("synthesizes only once per tool call id", () => {
    const guard = createToolInvariantGuard();
    const out = flat(guard, [
      { type: "tool-output-error", toolCallId: "tc", errorText: "boom" },
      { type: "tool-output-available", toolCallId: "tc", output: {} },
    ] as UIMessageChunk[]);
    // One synthetic input, then both original chunks.
    expect(out.map((c) => c.type)).toEqual([
      "tool-input-available",
      "tool-output-error",
      "tool-output-available",
    ]);
  });

  it("passes a start→delta pair through untouched", () => {
    const guard = createToolInvariantGuard();
    const out = flat(guard, [
      { type: "tool-input-start", toolCallId: "tc", toolName: "x" },
      { type: "tool-input-delta", toolCallId: "tc", inputTextDelta: "{" },
    ] as UIMessageChunk[]);
    expect(out.map((c) => c.type)).toEqual([
      "tool-input-start",
      "tool-input-delta",
    ]);
  });

  it("drops a delta with no preceding tool-input-start", () => {
    // Only `tool-input-start` populates the reader's partialToolCalls map —
    // neither a seeded part nor a `tool-input-available` does.
    for (const seeded of [[], ["tc"]]) {
      const guard = createToolInvariantGuard(seeded);
      const out = flat(guard, [
        {
          type: "tool-input-available",
          toolCallId: "tc",
          toolName: "x",
          input: {},
        },
        { type: "tool-input-delta", toolCallId: "tc", inputTextDelta: "{" },
      ] as UIMessageChunk[]);
      expect(out.map((c) => c.type)).toEqual(["tool-input-available"]);
    }
  });

  it("leaves non-tool chunks alone", () => {
    const guard = createToolInvariantGuard();
    const out = flat(guard, [
      { type: "start", messageId: "m" },
      { type: "text-delta", id: "t", delta: "hi" },
      { type: "finish" },
    ] as UIMessageChunk[]);
    expect(out.map((c) => c.type)).toEqual(["start", "text-delta", "finish"]);
  });
});
