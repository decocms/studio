import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_CONFIRMATION = defineTool({
  name: "UI_CONFIRMATION",
  description: "Display a confirmation dialog with customizable actions",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/confirmation" },
  inputSchema: z.object({
    title: z.string().describe("Dialog title"),
    message: z.string().describe("Confirmation message to display"),
    confirmLabel: z
      .string()
      .default("Confirm")
      .describe("Label for the confirm button"),
    cancelLabel: z
      .string()
      .default("Cancel")
      .describe("Label for the cancel button"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    return {
      message: `Confirmation "${input.title}": ${input.message} [${input.confirmLabel} / ${input.cancelLabel}]`,
    };
  },
});
