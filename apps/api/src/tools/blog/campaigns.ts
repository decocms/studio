import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import {
  CAMPAIGNS_DIR,
  recordPath,
  updateBlogRecord,
} from "../../file-storage/blog-state";
import { OrgFsNotFoundError } from "../../file-storage/org-fs";
import { notifyOrgFsChangeFromServer } from "../../file-storage/org-fs-notify";
import { callerRunThread } from "./blog-job";
import {
  applyCampaignPatch,
  CampaignPatchSchema,
  campaignPatchRefusal,
} from "./campaign-record";
import { conflictOrRethrow, RecordIdSchema, resolveBlogScope } from "./state";

export const BLOG_CAMPAIGN_UPDATE = defineTool({
  name: "BLOG_CAMPAIGN_UPDATE",
  description:
    "Change a blog campaign by merging `patch` into it: objects merge, arrays replace, and `null` removes a field. Send only what changed; `goal` and `briefing` are replaced whole. A campaign's agent writes only the campaign its chat shapes, and never its goal or status; a person sets only the goal and the status. Without `expect`, a write that lands meanwhile is merged with; with it, the call fails if the campaign moved since that version. Studio creates a campaign before its chat's first turn, so this never creates one.",
  annotations: {
    title: "Update a Blog Campaign",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },

  inputSchema: z.object({
    id: RecordIdSchema.describe("The campaign's id."),
    patch: CampaignPatchSchema,
    expect: z
      .string()
      .max(128)
      .optional()
      .describe(
        "The campaign file's version, from BLOG_STATE_GET's `versions` or this tool's last answer.",
      ),
  }),

  outputSchema: z.object({
    id: z.string(),
    campaign: z.record(z.string(), z.unknown()),
    version: z.string().describe("Pass it back as `expect` on the next write."),
  }),

  modelSummary: (r) => `Campaign ${r.id} saved.`,

  handler: async (input, ctx) => {
    const { organizationId, orgFs, brand, actor } = await resolveBlogScope(ctx);
    const runThreadId = callerRunThread(ctx);
    const path = recordPath(brand, CAMPAIGNS_DIR, input.id);

    let written;
    try {
      written = await updateBlogRecord(
        orgFs,
        actor,
        path,
        (stored) => {
          const refusal = campaignPatchRefusal(
            stored,
            input.patch,
            runThreadId,
          );
          if (refusal) throw new Error(refusal);
          return applyCampaignPatch(
            stored,
            input.patch,
            new Date().toISOString(),
          );
        },
        { expect: input.expect },
      );
    } catch (err) {
      if (err instanceof OrgFsNotFoundError) {
        throw new Error(
          `Campaign not found: ${input.id}. Studio creates a campaign before its chat's first turn.`,
        );
      }
      throw conflictOrRethrow(err);
    }

    await notifyOrgFsChangeFromServer(organizationId, HOME_MOUNT_PATH, [path]);
    return {
      id: input.id,
      campaign: written.data,
      version: written.entry.contentHash ?? "",
    };
  },
});
