import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_JSON_VIEWER = defineTool({
  name: "UI_JSON_VIEWER",
  description: "Display an interactive JSON tree viewer",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/json-viewer" },
  inputSchema: z.object({
    data: z.unknown().describe("JSON data to display"),
    title: z.string().default("JSON").describe("Title for the viewer"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    const preview = JSON.stringify(input.data).slice(0, 80);
    return {
      message: `JSON Viewer "${input.title}": ${preview}${JSON.stringify(input.data).length > 80 ? "…" : ""}`,
    };
  },
});
