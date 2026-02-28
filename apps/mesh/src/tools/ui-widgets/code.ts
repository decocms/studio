import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_CODE = defineTool({
  name: "UI_CODE",
  description: "Display a syntax-highlighted code snippet",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/code" },
  inputSchema: z.object({
    code: z.string().describe("Code content to display"),
    language: z
      .string()
      .default("typescript")
      .describe("Programming language for syntax highlighting"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    const lines = input.code.split("\n").length;
    return {
      message: `Code snippet (${input.language}, ${lines} line${lines === 1 ? "" : "s"})`,
    };
  },
});
