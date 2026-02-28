import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_NOTIFICATION = defineTool({
  name: "UI_NOTIFICATION",
  description: "Display a notification banner with type styling",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/notification" },
  inputSchema: z.object({
    message: z.string().describe("Notification message"),
    type: z
      .enum(["info", "success", "warning", "error"])
      .describe("Notification type for visual styling"),
    title: z.string().default("").describe("Optional notification title"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    const prefix = input.title ? `${input.title}: ` : "";
    return {
      message: `[${input.type.toUpperCase()}] ${prefix}${input.message}`,
    };
  },
});
