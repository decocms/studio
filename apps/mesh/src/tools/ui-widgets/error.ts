import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_ERROR = defineTool({
  name: "UI_ERROR",
  description: "Display an error message with optional code and details",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/error" },
  inputSchema: z.object({
    message: z.string().describe("Error message"),
    code: z
      .string()
      .default("")
      .describe("Error code (e.g. 'E404', 'TIMEOUT')"),
    details: z
      .string()
      .default("")
      .describe("Additional error details or stack trace"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    const prefix = input.code ? `[${input.code}] ` : "";
    return {
      message: `Error: ${prefix}${input.message}`,
    };
  },
});
