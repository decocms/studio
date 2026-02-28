import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_KBD = defineTool({
  name: "UI_KBD",
  description: "Display keyboard shortcut reference",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/kbd" },
  inputSchema: z.object({
    shortcuts: z
      .array(
        z.object({
          keys: z
            .array(z.string())
            .describe("Key combination (e.g. ['Ctrl', 'S'])"),
          description: z.string().describe("What the shortcut does"),
        }),
      )
      .default([])
      .describe("List of keyboard shortcuts to display"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    const summary = input.shortcuts
      .map((s) => `${s.keys.join("+")} → ${s.description}`)
      .join("; ");
    return {
      message: `Keyboard shortcuts (${input.shortcuts.length}): ${summary || "none"}`,
    };
  },
});
