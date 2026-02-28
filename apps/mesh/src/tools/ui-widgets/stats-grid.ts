import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_STATS_GRID = defineTool({
  name: "UI_STATS_GRID",
  description: "Display a grid of dashboard statistics",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/stats-grid" },
  inputSchema: z.object({
    stats: z
      .array(
        z.object({
          label: z.string().describe("Stat label"),
          value: z.string().describe("Stat value (displayed as-is)"),
          unit: z.string().default("").describe("Optional unit suffix"),
          trend: z.coerce.number().default(0).describe("Trend percentage"),
        }),
      )
      .default([])
      .describe("Array of stats to display in the grid"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    const summary = input.stats
      .map((s) => `${s.label}: ${s.value}${s.unit}`)
      .join(", ");
    return {
      message: `Stats grid (${input.stats.length} items): ${summary || "empty"}`,
    };
  },
});
