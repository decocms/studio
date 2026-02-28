import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_METRIC = defineTool({
  name: "UI_METRIC",
  description: "Display a key metric with optional unit and trend indicator",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/metric" },
  inputSchema: z.object({
    value: z.coerce.number().describe("Metric value to display"),
    label: z.string().describe("Label for the metric"),
    unit: z.string().default("").describe("Unit suffix (e.g. '%', 'ms', 'GB')"),
    trend: z.coerce
      .number()
      .default(0)
      .describe("Trend percentage (positive = up, negative = down)"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    const trendLabel =
      input.trend > 0
        ? `+${input.trend}%`
        : input.trend < 0
          ? `${input.trend}%`
          : "no change";
    return {
      message: `Metric "${input.label}": ${input.value}${input.unit} (${trendLabel})`,
    };
  },
});
