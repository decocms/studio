/**
 * preview_navigate — point the user's live preview at a page of the dev server.
 *
 * Returns at once, like `suggest_task`: the chat UI reads the call's input off
 * the run stream and navigates the preview iframe.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth, requireOrganization } from "@/core/studio-context";

const PreviewNavigateInputSchema = z.object({
  path: z
    .string()
    .max(2048)
    // `//host` resolves to another origin against the preview's base URL.
    .regex(/^\/(?!\/)/, "Must be a path on the dev server, starting with '/'.")
    .describe(
      "Path on the dev server to show, with any query string, e.g. '/products/blue-shirt' or '/search?q=shoes'.",
    ),
});

export const PREVIEW_NAVIGATE = defineTool({
  name: "preview_navigate",
  description:
    "Navigate the user's live preview of the dev server to a page. Call it after you build or " +
    "change a page so the user sees the result, or when they ask to see a page. The preview " +
    "already hot-reloads edits; call this only to change which page is shown.",
  annotations: {
    title: "Navigate Preview",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: PreviewNavigateInputSchema,
  outputSchema: z.object({ shown: z.literal(true) }),
  modelSummary: () => "The user's preview is now on that page.",
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    return { shown: true as const };
  },
});
