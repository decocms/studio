/**
 * render_html Built-in Tool
 *
 * Allows the agent to render arbitrary HTML inline in the chat inside a
 * sandboxed iframe. No server-side execution — the HTML is passed through
 * to the frontend which renders it in an isolated iframe.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";

const RenderHtmlInputSchema = z.object({
  html: z
    .string()
    .max(500_000)
    .describe(
      "Complete HTML document or fragment to render. Can include inline CSS and JavaScript.",
    ),
  title: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Optional title for the rendered preview. Defaults to 'HTML Preview'.",
    ),
});

export function createRenderHtmlTool() {
  return tool({
    description:
      "Render arbitrary HTML inline in the chat. Use this to present rich visual output " +
      "such as charts, tables, interactive previews, or mini-apps. The HTML runs in a " +
      "sandboxed iframe — include all CSS and JS inline. Do NOT use this for simple text " +
      "or markdown — only for content that benefits from HTML rendering.",
    inputSchema: zodSchema(RenderHtmlInputSchema),
    execute: async (input) => {
      return { html: input.html };
    },
  });
}
