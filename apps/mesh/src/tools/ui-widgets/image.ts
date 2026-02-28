import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_IMAGE = defineTool({
  name: "UI_IMAGE",
  description: "Display an image with optional caption",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/image" },
  inputSchema: z.object({
    src: z.string().describe("Image URL"),
    alt: z.string().default("").describe("Alt text for the image"),
    caption: z.string().default("").describe("Caption below the image"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    const desc = input.caption || input.alt || "no caption";
    return {
      message: `Image (${desc}): ${input.src}`,
    };
  },
});
