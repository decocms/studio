import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "../types.ts";
import { useFilterParts } from "./use-filter-parts.ts";

/**
 * `useFilterParts` is a pure function (despite the `use` prefix it calls no
 * React hooks), so we exercise it directly.
 *
 * Helper to build a minimal ChatMessage from a list of part `type`s plus
 * optional fields. Only `.type` (and `.text` for reasoning) is read by the hook
 * for ordering/grouping, so the cast is safe for these tests.
 */
function msg(parts: Array<Record<string, unknown>>): ChatMessage {
  return { id: "m1", role: "assistant", parts } as unknown as ChatMessage;
}

describe("useFilterParts", () => {
  it("coalesces consecutive reasoning parts into a single group", () => {
    const { reasoningGroups } = useFilterParts(
      msg([
        { type: "reasoning", text: "a" },
        { type: "reasoning", text: "b" },
        { type: "text", text: "done" },
      ]),
    );

    expect(reasoningGroups).toHaveLength(1);
    expect(reasoningGroups[0]!.parts.map((p) => p.text)).toEqual(["a", "b"]);
    expect(reasoningGroups[0]!.startIndex).toBe(0);
  });

  it("splits reasoning runs separated by a tool call into separate groups", () => {
    const { reasoningGroups } = useFilterParts(
      msg([
        { type: "reasoning", text: "first" },
        { type: "dynamic-tool", toolCallId: "t1", state: "output-available" },
        { type: "reasoning", text: "second" },
      ]),
    );

    expect(reasoningGroups).toHaveLength(2);
    expect(reasoningGroups[0]!.parts.map((p) => p.text)).toEqual(["first"]);
    expect(reasoningGroups[1]!.parts.map((p) => p.text)).toEqual(["second"]);
  });

  it("renders reasoning groups in arrival order, interleaved with tool calls (no hoist to top of step)", () => {
    const { renderOrder } = useFilterParts(
      msg([
        { type: "step-start" },
        { type: "reasoning", text: "first" },
        { type: "dynamic-tool", toolCallId: "t1", state: "output-available" },
        { type: "reasoning", text: "second" },
        { type: "dynamic-tool", toolCallId: "t2", state: "output-available" },
        { type: "text", text: "done" },
      ]),
    );

    // Expected interleaving (arrival order), NOT reasoning hoisted to the top:
    //   group(@1), part(2), group(@3), part(4), part(5)
    expect(
      renderOrder.map((item) =>
        item.kind === "reasoning-group"
          ? `group@${item.group.startIndex}`
          : `part@${item.index}`,
      ),
    ).toEqual(["group@1", "part@2", "group@3", "part@4", "part@5"]);
  });

  it("keeps reasoning-group ordering stable across step boundaries", () => {
    const { renderOrder } = useFilterParts(
      msg([
        { type: "reasoning", text: "s1" },
        { type: "dynamic-tool", toolCallId: "t1", state: "output-available" },
        { type: "step-start" },
        { type: "reasoning", text: "s2" },
        { type: "dynamic-tool", toolCallId: "t2", state: "output-available" },
      ]),
    );

    expect(
      renderOrder.map((item) =>
        item.kind === "reasoning-group"
          ? `group@${item.group.startIndex}`
          : `part@${item.index}`,
      ),
    ).toEqual(["group@0", "part@1", "group@3", "part@4"]);
  });
});
