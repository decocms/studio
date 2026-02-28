import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_SWITCH = defineTool({
  name: "UI_SWITCH",
  description: "Display a toggle switch control",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/switch" },
  inputSchema: z.object({
    label: z.string().describe("Label for the switch"),
    checked: z
      .boolean()
      .default(false)
      .describe("Whether the switch is toggled on"),
    description: z
      .string()
      .default("")
      .describe("Optional description below the label"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    const state = input.checked ? "ON" : "OFF";
    return {
      message: `Switch "${input.label}": ${state}`,
    };
  },
});
