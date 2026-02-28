import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_SPARKLINE = defineTool({
  name: "UI_SPARKLINE",
  description: "Display a compact sparkline trend chart",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/sparkline" },
  inputSchema: z.object({
    values: z
      .array(z.coerce.number())
      .default([])
      .describe("Array of numeric values for the sparkline"),
    label: z.string().default("Trend").describe("Label for the sparkline"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    const count = input.values.length;
    const last = count > 0 ? input.values[count - 1] : 0;
    return {
      message: `Sparkline "${input.label}": ${count} points, latest value ${last}`,
    };
  },
});
