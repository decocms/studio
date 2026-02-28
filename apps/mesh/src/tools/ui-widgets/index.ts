import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import { defineTool } from "../../core/define-tool.ts";

const msg = z.object({ message: z.string() });

const dataPoint = z.object({
  label: z.string().describe("Data point label"),
  value: z.coerce.number().describe("Data point value"),
});

export const UI_AREA_CHART = defineTool({
  name: "UI_AREA_CHART",
  description: "Display an area chart with gradient fill",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/area-chart" },
  inputSchema: z.object({
    data: z
      .array(dataPoint)
      .default([])
      .describe("Array of data points for the area chart"),
    title: z.string().default("Area Chart").describe("Title of the chart"),
  }),
  outputSchema: msg,
  handler: async (input) => {
    const summary = input.data.map((d) => `${d.label}: ${d.value}`).join(", ");
    return {
      message: `Area chart "${input.title}" with ${input.data.length} points: ${summary || "empty"}`,
    };
  },
});

export const UI_AVATAR = defineTool({
  name: "UI_AVATAR",
  description: "Display a user avatar with optional status indicator",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/avatar" },
  inputSchema: z.object({
    name: z.string().describe("User display name"),
    imageUrl: z.string().default("").describe("URL for the avatar image"),
    status: z
      .enum(["online", "offline", "busy", "away"])
      .optional()
      .describe("Optional online status indicator"),
  }),
  outputSchema: msg,
  handler: async (input) => {
    const statusText = input.status ? ` (${input.status})` : "";
    return { message: `Avatar: ${input.name}${statusText}` };
  },
});

export const UI_CALENDAR = defineTool({
  name: "UI_CALENDAR",
  description: "Display a mini calendar with highlighted dates",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/calendar" },
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
  outputSchema: msg,
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
    const n = input.highlightedDates.length;
    return {
      message: `Calendar: ${name} ${input.year}, ${n} highlighted date${n === 1 ? "" : "s"}`,
    };
  },
});

export const UI_CHART = defineTool({
  name: "UI_CHART",
  description: "Display an animated bar chart with labeled data points",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/chart" },
  inputSchema: z.object({
    data: z
      .array(dataPoint)
      .default([])
      .describe("Array of data points to chart"),
    title: z.string().default("Chart").describe("Title of the chart"),
  }),
  outputSchema: msg,
  handler: async (input) => {
    const summary = input.data.map((d) => `${d.label}: ${d.value}`).join(", ");
    return {
      message: `Chart "${input.title}" with ${input.data.length} data points: ${summary || "empty"}`,
    };
  },
});

export const UI_CODE = defineTool({
  name: "UI_CODE",
  description: "Display a syntax-highlighted code snippet",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/code?borderless=true" },
  inputSchema: z.object({
    code: z.string().describe("Code content to display"),
    language: z
      .string()
      .default("typescript")
      .describe("Programming language for syntax highlighting"),
  }),
  outputSchema: msg,
  handler: async (input) => {
    const lines = input.code.split("\n").length;
    return {
      message: `Code snippet (${input.language}, ${lines} line${lines === 1 ? "" : "s"})`,
    };
  },
});

export const UI_CONFIRMATION = defineTool({
  name: "UI_CONFIRMATION",
  description: "Display a confirmation dialog with customizable actions",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/confirmation" },
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
  outputSchema: msg,
  handler: async (input) => ({
    message: `Confirmation "${input.title}": ${input.message} [${input.confirmLabel} / ${input.cancelLabel}]`,
  }),
});

export const UI_COUNTER = defineTool({
  name: "UI_COUNTER",
  description:
    "Display an interactive counter widget with increment/decrement controls",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/counter" },
  inputSchema: z.object({
    initialValue: z.coerce
      .number()
      .default(0)
      .describe("Initial counter value"),
    label: z.string().default("Counter").describe("Label for the counter"),
  }),
  outputSchema: msg,
  handler: async (input) => ({
    message: `Counter "${input.label}" initialized at ${input.initialValue}`,
  }),
});

export const UI_DIFF = defineTool({
  name: "UI_DIFF",
  description: "Display a side-by-side text diff viewer",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/diff" },
  inputSchema: z.object({
    before: z.string().describe("Original text content"),
    after: z.string().describe("Modified text content"),
    title: z.string().default("Diff").describe("Title for the diff viewer"),
  }),
  outputSchema: msg,
  handler: async (input) => ({
    message: `Diff "${input.title}": ${input.before.split("\n").length} → ${input.after.split("\n").length} lines`,
  }),
});

export const UI_ERROR = defineTool({
  name: "UI_ERROR",
  description: "Display an error message with optional code and details",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/error?borderless=true" },
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
  outputSchema: msg,
  handler: async (input) => ({
    message: `Error: ${input.code ? `[${input.code}] ` : ""}${input.message}`,
  }),
});

export const UI_FORM_RESULT = defineTool({
  name: "UI_FORM_RESULT",
  description: "Display a form submission result summary",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/form-result" },
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
  outputSchema: msg,
  handler: async (input) => {
    const n = input.fields.length;
    return {
      message: `${input.title} (${input.success ? "success" : "failure"}): ${n} field${n === 1 ? "" : "s"}`,
    };
  },
});

export const UI_GREETING = defineTool({
  name: "UI_GREETING",
  description: "Display a personalized greeting card",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/greeting" },
  inputSchema: z.object({
    name: z.string().describe("Name of the person to greet"),
    message: z
      .string()
      .default("Welcome!")
      .describe("Greeting message to display"),
  }),
  outputSchema: msg,
  handler: async (input) => ({
    message: `Hello, ${input.name}! ${input.message}`,
  }),
});

export const UI_IMAGE = defineTool({
  name: "UI_IMAGE",
  description: "Display an image with optional caption",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/image" },
  inputSchema: z.object({
    src: z.string().describe("Image URL"),
    alt: z.string().default("").describe("Alt text for the image"),
    caption: z.string().default("").describe("Caption below the image"),
  }),
  outputSchema: msg,
  handler: async (input) => ({
    message: `Image (${input.caption || input.alt || "no caption"}): ${input.src}`,
  }),
});

export const UI_JSON_VIEWER = defineTool({
  name: "UI_JSON_VIEWER",
  description: "Display an interactive JSON tree viewer",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/json-viewer" },
  inputSchema: z.object({
    data: z.unknown().describe("JSON data to display"),
    title: z.string().default("JSON").describe("Title for the viewer"),
  }),
  outputSchema: msg,
  handler: async (input) => {
    const serialized = JSON.stringify(input.data);
    const preview = serialized.slice(0, 80);
    return {
      message: `JSON Viewer "${input.title}": ${preview}${serialized.length > 80 ? "…" : ""}`,
    };
  },
});

export const UI_KBD = defineTool({
  name: "UI_KBD",
  description: "Display keyboard shortcut reference",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/kbd" },
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
  outputSchema: msg,
  handler: async (input) => {
    const summary = input.shortcuts
      .map((s) => `${s.keys.join("+")} → ${s.description}`)
      .join("; ");
    return {
      message: `Keyboard shortcuts (${input.shortcuts.length}): ${summary || "none"}`,
    };
  },
});

export const UI_MARKDOWN = defineTool({
  name: "UI_MARKDOWN",
  description: "Display rendered markdown content",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/markdown" },
  inputSchema: z.object({
    content: z.string().describe("Markdown content to render"),
    title: z.string().default("").describe("Optional title above the content"),
  }),
  outputSchema: msg,
  handler: async (input) => {
    const lines = input.content.split("\n").length;
    const prefix = input.title ? `Markdown "${input.title}"` : "Markdown";
    return {
      message: `${prefix}: ${lines} line${lines === 1 ? "" : "s"} of content`,
    };
  },
});

export const UI_METRIC = defineTool({
  name: "UI_METRIC",
  description: "Display a key metric with optional unit and trend indicator",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/metric" },
  inputSchema: z.object({
    value: z.coerce.number().describe("Metric value to display"),
    label: z.string().describe("Label for the metric"),
    unit: z.string().default("").describe("Unit suffix (e.g. '%', 'ms', 'GB')"),
    trend: z.coerce
      .number()
      .default(0)
      .describe("Trend percentage (positive = up, negative = down)"),
  }),
  outputSchema: msg,
  handler: async (input) => {
    const trendLabel =
      input.trend > 0
        ? `+${input.trend}%`
        : input.trend < 0
          ? `${input.trend}%`
          : "no change";
    return {
      message: `Metric "${input.label}": ${input.value}${input.unit} (${trendLabel})`,
    };
  },
});

export const UI_NOTIFICATION = defineTool({
  name: "UI_NOTIFICATION",
  description: "Display a notification banner with type styling",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/notification?borderless=true" },
  inputSchema: z.object({
    message: z.string().describe("Notification message"),
    type: z
      .enum(["info", "success", "warning", "error"])
      .describe("Notification type for visual styling"),
    title: z.string().default("").describe("Optional notification title"),
  }),
  outputSchema: msg,
  handler: async (input) => ({
    message: `[${input.type.toUpperCase()}] ${input.title ? `${input.title}: ` : ""}${input.message}`,
  }),
});

export const UI_PROGRESS = defineTool({
  name: "UI_PROGRESS",
  description: "Display a visual progress bar with label and percentage",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/progress" },
  inputSchema: z.object({
    value: z.coerce.number().default(0).describe("Current progress value"),
    max: z.coerce.number().default(100).describe("Maximum progress value"),
    label: z
      .string()
      .default("Progress")
      .describe("Label for the progress bar"),
  }),
  outputSchema: msg,
  handler: async (input) => {
    const pct = input.max > 0 ? Math.round((input.value / input.max) * 100) : 0;
    return { message: `${input.label}: ${input.value}/${input.max} (${pct}%)` };
  },
});

export const UI_QUOTE = defineTool({
  name: "UI_QUOTE",
  description: "Display a quote with attribution",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/quote?borderless=true" },
  inputSchema: z.object({
    text: z.string().describe("The quote text"),
    author: z.string().default("Unknown").describe("Author of the quote"),
  }),
  outputSchema: msg,
  handler: async (input) => ({ message: `"${input.text}" — ${input.author}` }),
});

export const UI_RATING = defineTool({
  name: "UI_RATING",
  description: "Display a star rating indicator",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/rating" },
  inputSchema: z.object({
    value: z.coerce.number().default(0).describe("Current rating value"),
    max: z.coerce.number().default(5).describe("Maximum number of stars"),
    label: z.string().default("Rating").describe("Label for the rating"),
  }),
  outputSchema: msg,
  handler: async (input) => ({
    message: `Rating "${input.label}": ${input.value}/${input.max}`,
  }),
});

export const UI_SLIDER = defineTool({
  name: "UI_SLIDER",
  description: "Display a range slider control",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/slider" },
  inputSchema: z.object({
    value: z.coerce.number().default(50).describe("Current slider value"),
    min: z.coerce.number().default(0).describe("Minimum slider value"),
    max: z.coerce.number().default(100).describe("Maximum slider value"),
    label: z.string().default("Slider").describe("Label for the slider"),
  }),
  outputSchema: msg,
  handler: async (input) => ({
    message: `Slider "${input.label}": ${input.value} (range ${input.min}–${input.max})`,
  }),
});

export const UI_SPARKLINE = defineTool({
  name: "UI_SPARKLINE",
  description: "Display a compact sparkline trend chart",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/sparkline" },
  inputSchema: z.object({
    values: z
      .array(z.coerce.number())
      .default([])
      .describe("Array of numeric values for the sparkline"),
    label: z.string().default("Trend").describe("Label for the sparkline"),
  }),
  outputSchema: msg,
  handler: async (input) => {
    const count = input.values.length;
    const last = count > 0 ? input.values[count - 1] : 0;
    return {
      message: `Sparkline "${input.label}": ${count} points, latest value ${last}`,
    };
  },
});

export const UI_STATS_GRID = defineTool({
  name: "UI_STATS_GRID",
  description: "Display a grid of dashboard statistics",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/stats-grid?borderless=true" },
  inputSchema: z.object({
    stats: z
      .array(
        z.object({
          label: z.string().describe("Stat label"),
          value: z.string().describe("Stat value (displayed as-is)"),
          unit: z.string().default("").describe("Optional unit suffix"),
          trend: z.coerce.number().default(0).describe("Trend percentage"),
        }),
      )
      .default([])
      .describe("Array of stats to display in the grid"),
  }),
  outputSchema: msg,
  handler: async (input) => {
    const summary = input.stats
      .map((s) => `${s.label}: ${s.value}${s.unit}`)
      .join(", ");
    return {
      message: `Stats grid (${input.stats.length} items): ${summary || "empty"}`,
    };
  },
});

export const UI_STATUS = defineTool({
  name: "UI_STATUS",
  description: "Display a status badge indicator",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/status" },
  inputSchema: z.object({
    status: z
      .enum(["online", "offline", "busy", "away"])
      .describe("Current status"),
    label: z.string().describe("Label for the status badge"),
  }),
  outputSchema: msg,
  handler: async (input) => ({
    message: `Status "${input.label}": ${input.status}`,
  }),
});

export const UI_SWITCH = defineTool({
  name: "UI_SWITCH",
  description: "Display a toggle switch control",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/switch" },
  inputSchema: z.object({
    label: z.string().describe("Label for the switch"),
    checked: z
      .boolean()
      .default(false)
      .describe("Whether the switch is toggled on"),
    description: z
      .string()
      .default("")
      .describe("Optional description below the label"),
  }),
  outputSchema: msg,
  handler: async (input) => ({
    message: `Switch "${input.label}": ${input.checked ? "ON" : "OFF"}`,
  }),
});

export const UI_TABLE = defineTool({
  name: "UI_TABLE",
  description: "Display a data table with columns and rows",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/table" },
  inputSchema: z.object({
    columns: z.array(z.string()).describe("Column header names"),
    rows: z
      .array(z.array(z.string()))
      .default([])
      .describe("Row data as arrays of strings"),
    title: z.string().default("Table").describe("Title for the table"),
  }),
  outputSchema: msg,
  handler: async (input) => ({
    message: `Table "${input.title}": ${input.columns.length} columns, ${input.rows.length} rows`,
  }),
});

export const UI_TIMER = defineTool({
  name: "UI_TIMER",
  description: "Display an interactive countdown timer",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/timer" },
  inputSchema: z.object({
    duration: z.coerce
      .number()
      .default(60)
      .describe("Timer duration in seconds"),
    label: z.string().default("Timer").describe("Label for the timer"),
  }),
  outputSchema: msg,
  handler: async (input) => ({
    message: `Timer "${input.label}" set for ${input.duration}s`,
  }),
});

export const UI_TODO = defineTool({
  name: "UI_TODO",
  description: "Display an interactive todo list",
  _meta: { [RESOURCE_URI_META_KEY]: "/_widgets/todo" },
  inputSchema: z.object({
    items: z
      .array(
        z.object({
          text: z.string().describe("Todo item text"),
          completed: z
            .boolean()
            .default(false)
            .describe("Whether the item is completed"),
        }),
      )
      .default([])
      .describe("List of todo items"),
    title: z.string().default("Todo").describe("Title for the todo list"),
  }),
  outputSchema: msg,
  handler: async (input) => {
    const done = input.items.filter((i) => i.completed).length;
    return {
      message: `Todo "${input.title}": ${done}/${input.items.length} completed`,
    };
  },
});
