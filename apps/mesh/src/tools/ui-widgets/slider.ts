import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_SLIDER = defineTool({
  name: "UI_SLIDER",
  description: "Display a range slider control",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/slider" },
  inputSchema: z.object({
    value: z.coerce.number().default(50).describe("Current slider value"),
    min: z.coerce.number().default(0).describe("Minimum slider value"),
    max: z.coerce.number().default(100).describe("Maximum slider value"),
    label: z.string().default("Slider").describe("Label for the slider"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    return {
      message: `Slider "${input.label}": ${input.value} (range ${input.min}–${input.max})`,
    };
  },
});
