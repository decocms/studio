import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_CHART = defineTool({
  name: "UI_CHART",
  description: "Display an animated bar chart with labeled data points",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/chart" },
  inputSchema: z.object({
    data: z
      .array(
        z.object({
          label: z.string().describe("Data point label"),
          value: z.coerce.number().describe("Data point value"),
        }),
      )
      .default([])
      .describe("Array of data points to chart"),
    title: z.string().default("Chart").describe("Title of the chart"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    const summary = input.data.map((d) => `${d.label}: ${d.value}`).join(", ");
    return {
      message: `Chart "${input.title}" with ${input.data.length} data points: ${summary || "empty"}`,
    };
  },
});
