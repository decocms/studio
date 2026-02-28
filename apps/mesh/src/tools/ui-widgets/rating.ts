import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_RATING = defineTool({
  name: "UI_RATING",
  description: "Display a star rating indicator",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/rating" },
  inputSchema: z.object({
    value: z.coerce.number().default(0).describe("Current rating value"),
    max: z.coerce.number().default(5).describe("Maximum number of stars"),
    label: z.string().default("Rating").describe("Label for the rating"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    return {
      message: `Rating "${input.label}": ${input.value}/${input.max}`,
    };
  },
});
