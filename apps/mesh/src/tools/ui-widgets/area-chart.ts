import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_AREA_CHART = defineTool({
  name: "UI_AREA_CHART",
  description: "Display an area chart with gradient fill",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/area-chart" },
  inputSchema: z.object({
    data: z
      .array(
        z.object({
          label: z.string().describe("Data point label"),
          value: z.coerce.number().describe("Data point value"),
        }),
      )
      .default([])
      .describe("Array of data points for the area chart"),
    title: z.string().default("Area Chart").describe("Title of the chart"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    const summary = input.data.map((d) => `${d.label}: ${d.value}`).join(", ");
    return {
      message: `Area chart "${input.title}" with ${input.data.length} points: ${summary || "empty"}`,
    };
  },
});
