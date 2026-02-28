import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_TABLE = defineTool({
  name: "UI_TABLE",
  description: "Display a data table with columns and rows",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/table" },
  inputSchema: z.object({
    columns: z.array(z.string()).describe("Column header names"),
    rows: z
      .array(z.array(z.string()))
      .default([])
      .describe("Row data as arrays of strings"),
    title: z.string().default("Table").describe("Title for the table"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    return {
      message: `Table "${input.title}": ${input.columns.length} columns, ${input.rows.length} rows`,
    };
  },
});
