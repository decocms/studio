import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_GREETING = defineTool({
  name: "UI_GREETING",
  description: "Display a personalized greeting card",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/greeting" },
  inputSchema: z.object({
    name: z.string().describe("Name of the person to greet"),
    message: z
      .string()
      .default("Welcome!")
      .describe("Greeting message to display"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    return {
      message: `Hello, ${input.name}! ${input.message}`,
    };
  },
});
