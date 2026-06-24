/**
 * open — tells the Studio UI to open a file in the preview panel.
 *
 * The tool itself has no server-side side-effects: it emits a transient
 * `data-open-preview` stream part that the React client picks up in onChunk
 * to navigate the preview panel, then returns immediately.
 */

import { tool, type UIMessageStreamWriter } from "ai";
import { z } from "zod";

export const OpenInputSchema = z.object({
  filepath: z
    .string()
    .describe(
      "Home-volume-relative path of the HTML file to open in the preview panel " +
        "(e.g. `pages/landing.html` or `decks/q3-launch.html`).",
    ),
});

export function createOpenTool(writer: UIMessageStreamWriter) {
  return tool({
    description:
      "Open an HTML file in the Studio preview panel so the user can see it. " +
      "Call this after creating or editing a page or deck. " +
      "Pass the home-volume-relative path, e.g. `pages/landing.html`.",
    inputSchema: OpenInputSchema,
    execute: async ({ filepath }) => {
      // Strip any leading slash so "pages/landing.html" and
      // "/pages/landing.html" both produce the same deck tab id.
      const normalizedPath = filepath.replace(/^\/+/, "");
      // Emitted without an `id` so the part is NOT persisted in the message —
      // this is a one-shot navigation signal, not durable message state.
      writer.write({
        type: "data-open-preview",
        data: { filepath: normalizedPath },
      });
      return { success: true };
    },
  });
}
