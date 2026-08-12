import { describe, expect, test } from "bun:test";
import { computeHeatmapView } from "./utils.ts";

describe("computeHeatmapView", () => {
  test("maxValue only reflects cells for agents actually rendered", () => {
    // agent "a" and "b" are the top-2 agents by total calls (10 each).
    // agent "spike" has a lower overall total (8) so it doesn't make the
    // top-2, but its single toolX cell (8) exceeds any cell of "a" or "b".
    const cells = [
      {
        virtualMcpId: "a",
        toolName: "toolX",
        calls: 5,
        errors: 0,
        outputSize: 0,
      },
      {
        virtualMcpId: "a",
        toolName: "toolY",
        calls: 5,
        errors: 0,
        outputSize: 0,
      },
      {
        virtualMcpId: "b",
        toolName: "toolX",
        calls: 5,
        errors: 0,
        outputSize: 0,
      },
      {
        virtualMcpId: "b",
        toolName: "toolY",
        calls: 5,
        errors: 0,
        outputSize: 0,
      },
      {
        virtualMcpId: "spike",
        toolName: "toolX",
        calls: 8,
        errors: 0,
        outputSize: 0,
      },
    ];

    const view = computeHeatmapView(cells, "calls", 12, 2);

    expect(view.topAgentIds).toEqual(["a", "b"]);
    // Must be 5 (the highest cell among rendered agents), not 8 from the
    // excluded "spike" agent.
    expect(view.maxValue).toBe(5);
  });

  test("caps tools and agents to the requested counts", () => {
    const cells = Array.from({ length: 5 }, (_, i) => ({
      virtualMcpId: `agent-${i}`,
      toolName: `tool-${i}`,
      calls: i + 1,
      errors: 0,
      outputSize: 0,
    }));

    const view = computeHeatmapView(cells, "calls", 2, 2);

    expect(view.topTools).toHaveLength(2);
    expect(view.topAgentIds).toHaveLength(2);
  });
});
