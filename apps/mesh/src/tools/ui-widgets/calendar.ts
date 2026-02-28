import { z } from "zod";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { defineTool } from "../../core/define-tool.ts";

export const UI_CALENDAR = defineTool({
  name: "UI_CALENDAR",
  description: "Display a mini calendar with highlighted dates",
  _meta: { [RESOURCE_URI_META_KEY]: "ui://mesh/calendar" },
  inputSchema: z.object({
    month: z.coerce
      .number()
      .int()
      .min(1)
      .max(12)
      .describe("Month number (1–12)"),
    year: z.coerce.number().int().describe("Year (e.g. 2026)"),
    highlightedDates: z
      .array(z.coerce.number().int())
      .default([])
      .describe("Array of day numbers to highlight"),
  }),
  outputSchema: z.object({
    message: z.string(),
  }),
  handler: async (input) => {
    const monthNames = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    const name = monthNames[input.month - 1] ?? "Unknown";
    return {
      message: `Calendar: ${name} ${input.year}, ${input.highlightedDates.length} highlighted date${input.highlightedDates.length === 1 ? "" : "s"}`,
    };
  },
});
