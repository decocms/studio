import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_QUOTE = defineTool({
  name: "UI_QUOTE",
  description: "Display a quote with attribution",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/quote" },
  inputSchema: z.object({
    text: z.string().describe("The quote text"),
    author: z.string().default("Unknown").describe("Author of the quote"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    return {
      message: `"${input.text}" — ${input.author}`,
    };
  },
});
