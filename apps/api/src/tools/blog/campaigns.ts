import {
  type CampaignBriefing,
  CampaignBriefingSchema,
  campaignNextStep,
  CampaignRunSchema,
} from "@decocms/shared/blog-campaign";
import { blogJobOfThread } from "@decocms/shared/blog-job";
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import { z } from "zod";
import { threadBranch } from "@/tools/sandbox/thread-repo";
import { defineTool } from "../../core/define-tool";
import {
  CAMPAIGNS_DIR,
  deleteBlogRecords,
  readBlogRecord,
  recordPath,
  updateBlogRecord,
  writeBlogFiles,
} from "../../file-storage/blog-state";
import { type OrgFs, OrgFsNotFoundError } from "../../file-storage/org-fs";
import { notifyOrgFsChangeFromServer } from "../../file-storage/org-fs-notify";
import { blogJobStarter, callerRunThread } from "./blog-job";
import {
  applyCampaignPatch,
  CampaignPatchSchema,
  campaignPatchRefusal,
  campaignShell,
} from "./campaign-record";
import { cardRunInFlight } from "./card-run";
import { conflictOrRethrow, RecordIdSchema, resolveBlogScope } from "./state";
import { dispatchSuperAgentTurn, openBlogJobChat } from "./super-agent-turn";

/** The step a campaign's chat is asked to take: the next one on its own, or what a person asked. */
type CampaignTurn = "suggest" | "develop" | "adjust";

/** The rules every turn of a campaign's own chat runs under. */
export function blogCampaignInstructions(campaign: {
  brand: string;
  campaignId: string;
}): string {
  return [
    "You shape one blog campaign of this organization's content track, and nothing else.",
    "",
    `- The campaign is \`${campaign.campaignId}\`, kept in the brand folder \`home/brands/${campaign.brand}/\`. Read it, the brand and its other campaigns with BLOG_STATE_GET at the start of every turn.`,
    "- Follow `campaigns.md` in the `blogpost` skill.",
    `- Save what you produce with BLOG_CAMPAIGN_UPDATE on \`${campaign.campaignId}\`, sending only what changed. Never send \`status\` or \`goal\`: approving a campaign and setting its goal are a person's.`,
    "- Write in the brand's language, whatever language you are spoken to in.",
    "- Your Studio tools are namespaced `mcp__studio__`: where this names `BLOG_CAMPAIGN_UPDATE`, the tool you call is `mcp__studio__BLOG_CAMPAIGN_UPDATE`.",
  ].join("\n");
}

/** The turn that starts a step: a fixed ask, then the person's words. */
export function blogCampaignPrompt(
  turn: CampaignTurn,
  message?: string,
): string {
  const ask =
    turn === "suggest"
      ? "Suggest this campaign's briefings: follow `campaigns.md` in the `blogpost` skill. Save the evidence, then the briefings, present them here and wait."
      : turn === "develop"
        ? "Develop this campaign from its chosen briefing: follow `campaigns.md` in the `blogpost` skill. Save it as you go, present it here and wait."
        : "Change this campaign as the person asks: follow `campaigns.md` in the `blogpost` skill, keeping its status and goal.";
  const said = message?.trim();
  return said ? `${ask}\n\nFrom the person:\n${said}` : ask;
}

/** Why a campaign has nothing to start on its own. */
function nothingToStart(stored: Record<string, unknown>): string {
  return Array.isArray(stored.briefings) && stored.briefings.length > 0
    ? "Choose one of its briefings, or write one, to develop this campaign."
    : "This campaign is developed: approve it, or ask its chat for changes.";
}

/** Put a campaign's run and briefing back as they were, unless a later run moved them. */
async function restoreRun(
  orgFs: OrgFs,
  actor: string,
  path: string,
  requestedAt: string,
  previous: Record<string, unknown>,
): Promise<void> {
  await updateBlogRecord(orgFs, actor, path, (current) => {
    const run = CampaignRunSchema.safeParse(current.run).data;
    if (run?.requestedAt !== requestedAt) return current;
    const next = { ...current };
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    return next;
  }).catch((err) => console.error("[blog] campaign run restore failed", err));
}

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

export const BLOG_CAMPAIGN_RUN = defineTool({
  name: "BLOG_CAMPAIGN_RUN",
  description:
    "Start or continue a campaign's agent in the campaign's own chat. Without `campaignId`, creates a draft campaign and its chat, where the agent reads the store's VTEX, GA4 and Search Console and suggests briefings. With `campaignId`, takes the campaign's next step: develops the `briefing` given or chosen, or, for a campaign that has no chat yet, starts one with the person's `message`. A campaign shaped in a blogpost card continues in that card.",
  annotations: {
    title: "Run a Campaign's Agent",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },

  inputSchema: z.object({
    campaignId: RecordIdSchema.optional().describe(
      "The campaign to continue. Without it, a new draft is created.",
    ),
    briefing: CampaignBriefingSchema.optional().describe(
      "The briefing to develop: one of the suggestions, or the person's own words.",
    ),
    message: z
      .string()
      .trim()
      .max(4_000)
      .optional()
      .describe("What the person asks, for a campaign that has no chat yet."),
  }),

  outputSchema: z.object({
    campaignId: z.string(),
    threadId: z
      .string()
      .describe("The campaign's chat, to open beside the page."),
  }),

  requiresAiBudget: true,

  modelSummary: (r) =>
    `Campaign ${r.campaignId} running in chat ${r.threadId}.`,

  handler: async (input, ctx) => {
    const { organizationId, orgFs, brand, actor } = await resolveBlogScope(ctx);
    const userId = blogJobStarter(ctx, "a campaign's agent");
    const now = new Date().toISOString();
    const run = { requestedAt: now, requestedBy: userId };
    const announce = (path: string) =>
      notifyOrgFsChangeFromServer(organizationId, HOME_MOUNT_PATH, [path]);
    const open = (
      campaignId: string,
      threadId: string,
      title: string,
      turn: CampaignTurn,
    ) =>
      openBlogJobChat(ctx, {
        organizationId,
        userId,
        threadId,
        job: { kind: "campaign", brand, campaignId },
        title,
        text: blogCampaignPrompt(turn, input.message),
        instructions: blogCampaignInstructions({ brand, campaignId }),
      });
    const briefingTitle = (briefing: CampaignBriefing | undefined) =>
      briefing?.text.split("\n")[0]?.trim() || "Campaign";

    if (!input.campaignId) {
      const campaignId = crypto.randomUUID();
      const threadId = crypto.randomUUID();
      const path = recordPath(brand, CAMPAIGNS_DIR, campaignId);
      await writeBlogFiles(orgFs, actor, [
        {
          path,
          data: campaignShell(threadId, run, now, input.briefing),
          expect: { absent: true },
        },
      ]);
      await announce(path);
      try {
        await open(
          campaignId,
          threadId,
          briefingTitle(input.briefing),
          input.briefing ? "develop" : "suggest",
        );
      } catch (err) {
        await deleteBlogRecords(orgFs, brand, actor, CAMPAIGNS_DIR, [
          campaignId,
        ]);
        await announce(path);
        throw err;
      }
      return { campaignId, threadId };
    }

    const campaignId = input.campaignId;
    const path = recordPath(brand, CAMPAIGNS_DIR, campaignId);
    const record = await readBlogRecord(orgFs, path);
    if (!record) throw new Error(`Campaign not found: ${campaignId}`);
    const stored = record.data;
    const step = input.briefing ? "develop" : campaignNextStep(stored);
    const previous = { run: stored.run, briefing: stored.briefing };
    const stamp = (extra: Record<string, unknown> = {}) =>
      updateBlogRecord(orgFs, actor, path, (current) => ({
        ...current,
        ...extra,
        run,
        ...(input.briefing ? { briefing: input.briefing } : {}),
        updatedAt: now,
      }));

    const chatId =
      typeof stored.threadId === "string" && stored.threadId
        ? stored.threadId
        : null;
    if (chatId) {
      const thread = await ctx.storage.threads.get(chatId).catch(() => null);
      const job = blogJobOfThread(thread?.metadata);
      if (
        !thread ||
        job?.kind !== "campaign" ||
        job.campaignId !== campaignId
      ) {
        throw new Error(
          "This campaign is shaped in a blogpost card's chat: continue there.",
        );
      }
      if (thread.created_by !== userId) {
        throw new Error(
          "This campaign's chat belongs to the person who started it.",
        );
      }
      const lastRun = CampaignRunSchema.safeParse(stored.run).data;
      if (cardRunInFlight(lastRun, thread, Date.now())) {
        throw new Error("This campaign's agent is already at work.");
      }
      if (!step) throw new Error(nothingToStart(stored));
      await stamp();
      await announce(path);
      try {
        await dispatchSuperAgentTurn(ctx, {
          organizationId,
          userId,
          threadId: chatId,
          branch: thread.branch ?? threadBranch(chatId),
          text: blogCampaignPrompt(step, input.message),
          instructions: blogCampaignInstructions({ brand, campaignId }),
          fence: `campaign:${chatId}:${now}`,
          requestedAt: now,
        });
      } catch (err) {
        await restoreRun(orgFs, actor, path, now, previous);
        await announce(path);
        throw err;
      }
      return { campaignId, threadId: chatId };
    }

    if (!step && !input.message?.trim()) {
      throw new Error(
        "Say what to change: this campaign has nothing to start on its own.",
      );
    }
    const threadId = crypto.randomUUID();
    await stamp({ threadId });
    await announce(path);
    try {
      const name =
        typeof stored.campaignName === "string" ? stored.campaignName : "";
      await open(
        campaignId,
        threadId,
        name || briefingTitle(input.briefing),
        step ?? "adjust",
      );
    } catch (err) {
      await restoreRun(orgFs, actor, path, now, {
        ...previous,
        threadId: undefined,
      });
      await announce(path);
      throw err;
    }
    return { campaignId, threadId };
  },
});
