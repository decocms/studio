import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_TIMER = defineTool({
  name: "UI_TIMER",
  description: "Display an interactive countdown timer",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/timer" },
  inputSchema: z.object({
    duration: z.coerce
      .number()
      .default(60)
      .describe("Timer duration in seconds"),
    label: z.string().default("Timer").describe("Label for the timer"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    return {
      message: `Timer "${input.label}" set for ${input.duration}s`,
    };
  },
});
