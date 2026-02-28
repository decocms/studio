import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_FORM_RESULT = defineTool({
  name: "UI_FORM_RESULT",
  description: "Display a form submission result summary",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/form-result" },
  inputSchema: z.object({
    fields: z
      .array(
        z.object({
          label: z.string().describe("Field label"),
          value: z.string().describe("Field value"),
        }),
      )
      .default([])
      .describe("Form fields and their values"),
    title: z
      .string()
      .default("Form Result")
      .describe("Title for the result display"),
    success: z
      .boolean()
      .default(true)
      .describe("Whether the form submission was successful"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    const status = input.success ? "success" : "failure";
    return {
      message: `${input.title} (${status}): ${input.fields.length} field${input.fields.length === 1 ? "" : "s"}`,
    };
  },
});
