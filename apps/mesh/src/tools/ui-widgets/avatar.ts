import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_AVATAR = defineTool({
  name: "UI_AVATAR",
  description: "Display a user avatar with optional status indicator",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/avatar" },
  inputSchema: z.object({
    name: z.string().describe("User display name"),
    imageUrl: z.string().default("").describe("URL for the avatar image"),
    status: z
      .enum(["online", "offline", "busy", "away"])
      .optional()
      .describe("Optional online status indicator"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    const statusText = input.status ? ` (${input.status})` : "";
    return {
      message: `Avatar: ${input.name}${statusText}`,
    };
  },
});
