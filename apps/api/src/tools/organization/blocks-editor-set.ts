/**
 * ORGANIZATION_BLOCKS_EDITOR_SET — pick the org's blocks editor.
 *
 * A member-writable companion to ORGANIZATION_SETTINGS_UPDATE: any member may
 * switch the editor for the whole org, so this lives in basic-usage while the
 * general settings tool stays behind org:manage. It writes only the
 * `new_blocks_editor` flag, so it can't widen what a regular member can change.
 */

import { z } from "zod";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

export const ORGANIZATION_BLOCKS_EDITOR_SET = defineTool({
  name: "ORGANIZATION_BLOCKS_EDITOR_SET",
  description:
    "Turn the redesigned blocks editor on or off for every member of the organization.",
  annotations: {
    title: "Set Blocks Editor",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    enabled: z
      .boolean()
      .describe("Whether the org uses the new blocks editor."),
  }),
  outputSchema: z.object({
    enabled: z.boolean(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);

    const settings = await ctx.storage.organizationSettings.upsert(org.id, {
      flags: { new_blocks_editor: input.enabled },
    });
    return { enabled: orgFlagEnabled(settings.flags, "new_blocks_editor") };
  },
});
