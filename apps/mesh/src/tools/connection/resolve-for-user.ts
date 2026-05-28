/**
 * CONNECTION_RESOLVE_FOR_USER
 *
 * App-only tool that returns the calling user's connection for a given
 * app_id, using the same resolution rules as the agent slot resolver
 * (prefer user-private, fall back to org-shared). Returns null when
 * nothing matches.
 *
 * Powers the GitHub-import picker (and any future per-user picker) so
 * the UI doesn't have to do the resolution itself.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { resolveSlot } from "../../core/slot-resolver";

export const CONNECTION_RESOLVE_FOR_USER = defineTool({
  name: "CONNECTION_RESOLVE_FOR_USER",
  description:
    "Return the calling user's connection for a given app_id (user-private preferred, org-shared fallback). Returns null when nothing matches.",
  annotations: {
    title: "Resolve Connection For User",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    app_id: z.string().describe("app_id to resolve (e.g. 'mcp-github')"),
  }),
  outputSchema: z.object({
    connectionId: z.string().nullable(),
    access: z.enum(["user", "org"]).nullable(),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error("Organization context required");
    }

    const invokerUserId = ctx.auth.user?.id ?? ctx.auth.apiKey?.userId ?? null;
    if (!invokerUserId) {
      return { connectionId: null, access: null };
    }

    const resolved = await resolveSlot(ctx.db, {
      organizationId,
      invokerUserId,
      appId: input.app_id,
    });
    return {
      connectionId: resolved?.connectionId ?? null,
      access: resolved?.access ?? null,
    };
  },
});
