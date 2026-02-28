import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_COUNTER = defineTool({
  name: "UI_COUNTER",
  description:
    "Display an interactive counter widget with increment/decrement controls",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/counter" },
  inputSchema: z.object({
    initialValue: z.coerce
      .number()
      .default(0)
      .describe("Initial counter value"),
    label: z.string().default("Counter").describe("Label for the counter"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    return {
      message: `Counter "${input.label}" initialized at ${input.initialValue}`,
    };
  },
});
