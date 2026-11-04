import { createHash } from "node:crypto";
import {
  BLOG_CARD_PHASES,
  BLOG_CARD_THREAD_KEY,
  type BlogCard,
  type BlogCardPhase,
  blogCardBranch,
  BlogCardSchema,
} from "@decocms/shared/blog-card";
import {
  CampaignBriefingSchema,
  campaignNextStep,
} from "@decocms/shared/blog-campaign";
import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import { getDecopilotId } from "@decocms/shared/sdk";
import { z } from "zod";
import { resolveOrCreateHead } from "@/decofile/read-decofile";
import { TASK_RUN_INSTRUCTIONS_KEY } from "@/harnesses/claude-code-env";
import { agentSandboxEnabled } from "@/settings";
import { threadBranch } from "@/tools/sandbox/thread-repo";
import { defineTool } from "../../core/define-tool";
import { getUserId } from "../../core/studio-context";
import {
  CAMPAIGNS_DIR,
  CARDS_DIR,
  deleteBlogRecords,
  readBlogRecord,
  recordPath,
  updateBlogRecord,
  writeBlogFiles,
} from "../../file-storage/blog-state";
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import { notifyOrgFsChangeFromServer } from "../../file-storage/org-fs-notify";
import { emitBlogCardUpdated } from "./card-events";
import { callerRunThread, runInFlight } from "./blog-job";
import { restoreCampaignRun } from "./campaigns";
import { campaignShell } from "./campaign-record";
import { CardIdSchema, parseCard } from "./cards";
import { resolveSiteProject, resolveSiteRepo } from "./site-repo";
import { conflictOrRethrow, resolveBlogScope } from "./state";
import type { ClaudeCodeEffort } from "@/harnesses/claude-code-env";
import { dispatchSuperAgentTurn } from "./super-agent-turn";

/**
 * Starting a blogpost card's agent: the Super Agent, on Claude Code, in a chat
 * of the card's own, working the card with the `blogpost` skill.
 *
 * A run instead of a request for the reason the deleted blog run had: an edge
 * proxy hangs up at around 100 seconds, and bringing a hypothesis or writing a
 * post takes minutes. The call answers once the run is queued, and the card is
 * where the work shows up, step by step, as the agent saves it.
 *
 * The chat is the card's for good: both phases run in it, so the execution
 * resumes the session that brought the hypothesis, and a person adjusts either
 * by writing to it. Only whoever started it may write to it, like any chat.
 */

const MAX_TITLE_CHARS = 120;

/** What the card's `error` field holds at most. */
const MAX_ERROR_CHARS = 2_000;

/** The card's chat id. Fixed per card, so a retried start finds its chat. */
export function blogCardThreadId(organizationId: string, cardId: string) {
  const digest = createHash("sha256")
    .update(`blog-card:${organizationId}:${cardId}`)
    .digest("hex")
    .slice(0, 32);
  return `thrd_${digest}`;
}

/**
 * The card as a run of `phase` claims it, or a refusal. Clears what the last
 * run left: its error, and for an execution the post it wrote.
 */
export function phaseClaim(
  card: BlogCard,
  phase: BlogCardPhase,
  claim: {
    threadId: string;
    requestedAt: string;
    requestedBy: string;
    fileConfigId?: string;
    /** The draft Studio creates for the card when it links none yet. */
    shellId?: string;
  },
  /** The card's campaign as stored, or null when it links none or the file is gone. */
  linked: { status: string; threadId?: string } | null,
): BlogCard {
  const run = {
    phase,
    requestedAt: claim.requestedAt,
    requestedBy: claim.requestedBy,
  };
  const { error: _error, ...rest } = card;
  if (phase === "campaign") {
    if (card.status !== "ideas") {
      throw new Error(
        `A campaign is shaped while the card is in ideas, and this one is ${card.status}.`,
      );
    }
    if (linked && linked.status !== "draft") {
      throw new Error(
        "The card's campaign is approved: bring the hypothesis instead.",
      );
    }
    if (linked && linked.threadId !== claim.threadId) {
      throw new Error(
        "The card's campaign is shaped in another chat. Link an approved campaign, or unlink it and let the card's agent shape a new one.",
      );
    }
    const campaignId = linked ? card.campaignId : claim.shellId;
    if (!campaignId) {
      throw new Error("A campaign phase needs a campaign to shape.");
    }
    return {
      ...rest,
      campaignId,
      threadId: claim.threadId,
      run,
      updatedAt: claim.requestedAt,
    };
  }
  if (phase === "hypothesis") {
    if (card.status !== "ideas") {
      throw new Error(
        `A hypothesis is brought while the card is in ideas, and this one is ${card.status}. Adjust it in the card's chat instead.`,
      );
    }
    if (!linked) {
      throw new Error(
        "Link a campaign before bringing the hypothesis: an approved one, or one the card's agent shapes.",
      );
    }
    if (linked.status === "draft") {
      throw new Error(
        "Approve the card's campaign before bringing its hypothesis.",
      );
    }
    return {
      ...rest,
      threadId: claim.threadId,
      run,
      updatedAt: claim.requestedAt,
    };
  }
  if (card.status === "scheduled" || card.status === "published") {
    throw new Error(
      `This card is ${card.status}. Move it back to awaiting review before writing it again.`,
    );
  }
  if (!linked) {
    throw new Error(
      "The card's campaign is gone. Link another one before writing its post.",
    );
  }
  if (!card.hypothesis?.statement?.trim()) {
    throw new Error(
      "The card has no hypothesis to write from yet. Bring one, then approve it.",
    );
  }
  const {
    post: _post,
    postKey: _postKey,
    commit: _commit,
    ...unwritten
  } = rest;
  return {
    ...unwritten,
    status: "generating",
    stage: "grounding",
    branch: blogCardBranch(card.id),
    threadId: claim.threadId,
    ...(claim.fileConfigId ? { fileConfigId: claim.fileConfigId } : {}),
    run,
    updatedAt: claim.requestedAt,
  };
}

/**
 * The rules the card's chat runs under, fixed when it is created and reused
 * by every later turn, a person's included.
 */
export function blogCardRunInstructions(card: {
  id: string;
  virtualMcpId: string;
  brand: string;
}): string {
  const branch = blogCardBranch(card.id);
  return [
    "You work one blogpost card of this organization's content track, and nothing else.",
    "",
    `- The card is \`${card.id}\`, kept in the brand folder \`home/brands/${card.brand}/\`. Read it with BLOG_CARD_GET at the start of every turn, and save what you produce with BLOG_CARD_UPDATE after every step, sending only what changed.`,
    `- The site is \`${card.virtualMcpId}\`: pass it as \`virtualMcpId\` wherever a tool asks for one.`,
    "- Follow the `blogpost` skill: its `campaigns.md` shapes the card's campaign, its `hypothesis.md` brings the hypothesis, its `execute.md` writes the post.",
    "- While the card's campaign is a draft shaped in this chat, save it with BLOG_CAMPAIGN_UPDATE on the card's `campaignId`, sending only what changed, its goals included, and never `status`: approving it is a person's.",
    `- The post is written on the branch \`${branch}\`. Pass it as \`branch\` to every tool that takes one, and never write to the repository's default branch.`,
    "- Never move the card to scheduled or published, and never publish the post. A person does both.",
    "- Write in the brand's language, whatever language you are spoken to in.",
    "- Your Studio tools are namespaced `mcp__studio__`: where this names `BLOG_CARD_UPDATE`, the tool you call is `mcp__studio__BLOG_CARD_UPDATE`.",
  ].join("\n");
}

/**
 * How hard a phase thinks. Writing the post is the one a reader judges, so it
 * gets more reasoning than the runner's low where the organization turned that
 * on; every other phase keeps low.
 */
export function phaseEffort(
  phase: BlogCardPhase,
  flags: Parameters<typeof orgFlagEnabled>[0],
): ClaudeCodeEffort | undefined {
  return phase === "execute" &&
    orgFlagEnabled(flags, "blog_writing_high_effort")
    ? "high"
    : undefined;
}

/** The turn that starts a phase: a fixed ask, then the person's words. */
export function blogCardRunPrompt(
  phase: BlogCardPhase,
  message: string | undefined,
  step?: "suggest" | "develop",
): string {
  let ask: string;
  switch (phase) {
    case "campaign":
      ask =
        step === "develop"
          ? "Develop this card's campaign from its chosen briefing: follow `campaigns.md` in the `blogpost` skill. Save it as you go, present it here and wait."
          : "Shape this card's campaign: follow `campaigns.md` in the `blogpost` skill. Save the evidence on the campaign, then three briefings, present them here and wait.";
      break;
    case "hypothesis":
      ask =
        "Bring this card's hypothesis: follow `hypothesis.md` in the `blogpost` skill. When it is saved on the card, present it here and wait.";
      break;
    case "execute":
      ask =
        "The hypothesis is approved. Write the post: follow `execute.md` in the `blogpost` skill, saving the card after every stage.";
      break;
  }
  const said = message?.trim();
  return said ? `${ask}\n\nFrom the person:\n${said}` : ask;
}

/**
 * What a start that never reached the agent leaves on the card: its cause, so
 * the card still says what to fix — a missing model, say — after the toast.
 */
export function dispatchFailure(err: unknown): string {
  const said = (err instanceof Error ? err.message : String(err)).trim();
  const reason = said || "The run could not start.";
  return reason.length > MAX_ERROR_CHARS
    ? `${reason.slice(0, MAX_ERROR_CHARS - 1)}…`
    : reason;
}

function threadTitle(card: BlogCard): string {
  const line =
    card.hypothesis?.title?.trim() ||
    card.prompt?.trim().split("\n")[0]?.trim() ||
    card.id;
  const title = `Blogpost: ${line}`;
  return title.length > MAX_TITLE_CHARS
    ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…`
    : title;
}

export const BLOG_CARD_RUN = defineTool({
  name: "BLOG_CARD_RUN",
  description:
    "Start a blogpost card's agent and return the chat it works in. `campaign` shapes the card's campaign, for a card in ideas without an approved one: the agent suggests briefings, then develops the `briefing` given or chosen. `hypothesis` brings the post's hypothesis from the store's systems once the card's campaign is approved. `execute` writes the post from the approved hypothesis on the card's own branch, moving the card to generating. Answers once the run is queued; the card fills in as the agent saves it.",
  annotations: {
    title: "Run a Blogpost Card",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },

  requiresAiBudget: true,

  inputSchema: z.object({
    id: CardIdSchema,
    phase: z.enum(BLOG_CARD_PHASES),
    message: z
      .string()
      .max(4_000)
      .optional()
      .describe(
        "What the person adds, in their words. For a hypothesis it defaults to what they asked when creating the card.",
      ),
    fileConfigId: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("The bucket the post's images go to, kept on the card."),
    briefing: CampaignBriefingSchema.optional().describe(
      "For the campaign phase: the briefing to develop, one of the suggestions or the person's own words.",
    ),
  }),

  outputSchema: z.object({
    card: BlogCardSchema,
    threadId: z.string().describe("The card's chat, where the run happens."),
  }),

  modelSummary: (r) => `Card ${r.card.id} running in chat ${r.threadId}.`,

  handler: async (input, ctx) => {
    const { organizationId, orgFs, brand, actor } = await resolveBlogScope(ctx);
    if (callerRunThread(ctx)) {
      throw new Error("A run cannot start a card's run; the board does.");
    }
    if (!agentSandboxEnabled()) {
      throw new Error(
        "A card's agent runs in a sandbox, and this deployment has none.",
      );
    }
    const userId = getUserId(ctx);
    if (!userId) throw new Error("A card's run needs a person to belong to.");

    const path = recordPath(brand, CARDS_DIR, input.id);
    const read = await readBlogRecord(orgFs, path);
    if (!read) throw new Error(`Card not found: ${input.id}`);
    const card = parseCard(input.id, read.data);

    const project = await resolveSiteProject(
      ctx,
      organizationId,
      card.virtualMcpId,
    );
    if (project.status !== "active") {
      throw new Error("The card's site is not active.");
    }

    const threadId = card.threadId ?? blogCardThreadId(organizationId, card.id);
    const existing = await ctx.storage.threads.get(threadId).catch(() => null);
    if (existing && existing.created_by !== userId) {
      throw new Error(
        "This card's chat belongs to the person who started it, and only they can run it.",
      );
    }
    if (runInFlight(card.run, existing, Date.now())) {
      throw new Error(
        "The card's agent is already working. Wait for it, or write to it in the card's chat.",
      );
    }

    const campaignPath = card.campaignId
      ? recordPath(brand, CAMPAIGNS_DIR, card.campaignId)
      : null;
    const campaign = campaignPath
      ? await readBlogRecord(orgFs, campaignPath)
      : null;
    const linked = campaign
      ? {
          status:
            typeof campaign.data.status === "string"
              ? campaign.data.status
              : "draft",
          threadId:
            typeof campaign.data.threadId === "string"
              ? campaign.data.threadId
              : undefined,
        }
      : null;

    const requestedAt = new Date().toISOString();
    const shellId =
      input.phase === "campaign" && !campaign ? crypto.randomUUID() : undefined;
    const claimed = phaseClaim(
      card,
      input.phase,
      {
        threadId,
        requestedAt,
        requestedBy: userId,
        fileConfigId: input.fileConfigId,
        shellId,
      },
      linked,
    );
    const step =
      input.phase === "campaign"
        ? input.briefing
          ? "develop"
          : campaignNextStep(campaign?.data ?? { status: "draft" })
        : null;
    if (input.phase === "campaign" && !step) {
      throw new Error(
        Array.isArray(campaign?.data.briefings) &&
          campaign.data.briefings.length > 0
          ? "Choose one of the campaign's briefings, or write one, to develop it."
          : "The card's campaign is developed: approve it, or ask the card's chat for changes.",
      );
    }

    if (input.phase === "execute") {
      const site = await resolveSiteRepo(
        ctx,
        organizationId,
        card.virtualMcpId,
      );
      const branch = blogCardBranch(card.id);
      if (branch === (await site.client.getDefaultBranch())) {
        throw new Error(
          `"${branch}" is the repository's default branch. Create a card with another id to write this post.`,
        );
      }
      // Cut before any tool reads it: a branch that does not exist reads as an error.
      await resolveOrCreateHead(site.client, branch);
    }

    // The campaign names this chat before the card claims it, so the agent's first write finds it.
    const campaignRun = { requestedAt, requestedBy: userId };
    const shapedPath = claimed.campaignId
      ? recordPath(brand, CAMPAIGNS_DIR, claimed.campaignId)
      : null;
    const before = {
      run: campaign?.data.run,
      briefing: campaign?.data.briefing,
    };
    const announceCampaign = () =>
      shapedPath
        ? notifyOrgFsChangeFromServer(organizationId, HOME_MOUNT_PATH, [
            shapedPath,
          ])
        : Promise.resolve();
    const undoCampaign = async () => {
      if (!shapedPath || !claimed.campaignId) return;
      if (shellId) {
        await deleteBlogRecords(orgFs, brand, actor, CAMPAIGNS_DIR, [
          claimed.campaignId,
        ]);
      } else {
        await restoreCampaignRun(orgFs, actor, shapedPath, requestedAt, before);
      }
      await announceCampaign();
    };
    if (input.phase === "campaign" && shapedPath) {
      if (shellId) {
        await writeBlogFiles(orgFs, actor, [
          {
            path: shapedPath,
            data: campaignShell(
              threadId,
              campaignRun,
              requestedAt,
              input.briefing,
            ),
            expect: { absent: true },
          },
        ]);
      } else {
        await updateBlogRecord(orgFs, actor, shapedPath, (current) => ({
          ...current,
          run: campaignRun,
          ...(input.briefing ? { briefing: input.briefing } : {}),
          updatedAt: requestedAt,
        }));
      }
      await announceCampaign();
    }

    // Claimed before dispatch: a second start that read this version is refused.
    try {
      await updateBlogRecord(orgFs, actor, path, () => claimed, {
        expect: read.version,
      });
    } catch (err) {
      if (input.phase === "campaign") await undoCampaign();
      throw conflictOrRethrow(err);
    }
    emitBlogCardUpdated(organizationId, claimed);

    let createdThread = false;
    /** Undo the claim, and the chat when this call made it, keeping the reason. */
    const rollBack = async (reason: unknown) => {
      if (createdThread) {
        await ctx.storage.threads
          .delete(threadId)
          .catch((err) =>
            console.error("[blog] card chat cleanup failed", err),
          );
      }
      try {
        const { data } = await updateBlogRecord(orgFs, actor, path, (stored) =>
          parseCard(card.id, stored).run?.requestedAt === requestedAt
            ? {
                ...card,
                ...(claimed.campaignId
                  ? { campaignId: claimed.campaignId }
                  : {}),
                error: dispatchFailure(reason),
                updatedAt: new Date().toISOString(),
              }
            : stored,
        );
        emitBlogCardUpdated(organizationId, parseCard(card.id, data));
      } catch (err) {
        console.error("[blog] card claim rollback failed", err);
      }
      if (input.phase === "campaign" && shapedPath) {
        // The draft stays linked, so a retry continues it; only its run stamp goes.
        await restoreCampaignRun(orgFs, actor, shapedPath, requestedAt, {
          run: before.run,
        });
        await announceCampaign();
      }
    };

    try {
      const instructions = blogCardRunInstructions({ ...card, brand });
      const sandboxBranch = existing?.branch ?? threadBranch(threadId);
      const stored = existing?.metadata as Record<string, unknown> | null;
      if (existing && stored?.[TASK_RUN_INSTRUCTIONS_KEY] !== instructions) {
        // A chat keeps the instructions it was created with for the turns a person types.
        await ctx.storage.threads.update(threadId, {
          metadata: { ...stored, [TASK_RUN_INSTRUCTIONS_KEY]: instructions },
        });
      }
      if (!existing) {
        const created = await ctx.storage.threads.create({
          id: threadId,
          organization_id: organizationId,
          title: threadTitle(claimed),
          status: "in_progress",
          virtual_mcp_id: getDecopilotId(organizationId),
          // The terminal writer skips v1 threads, so a v1 run never ends.
          message_storage_version: 2,
          harness_id: "claude-code",
          created_by: userId,
          branch: sandboxBranch,
          metadata: {
            runtime: "sandbox",
            [TASK_RUN_INSTRUCTIONS_KEY]: instructions,
            [BLOG_CARD_THREAD_KEY]: { cardId: card.id, brand },
          },
        });
        createdThread = created.isNew;
      }

      await dispatchSuperAgentTurn(ctx, {
        organizationId,
        userId,
        threadId,
        branch: sandboxBranch,
        text: blogCardRunPrompt(
          input.phase,
          input.message ??
            (input.phase === "execute" ? undefined : card.prompt),
          step ?? undefined,
        ),
        instructions,
        fence: `blog-card:${threadId}:${input.phase}:${requestedAt}`,
        requestedAt,
        effort: phaseEffort(
          input.phase,
          (await ctx.storage.organizationSettings.get(organizationId))?.flags,
        ),
      });
    } catch (err) {
      await rollBack(err);
      throw err;
    }

    return { card: claimed, threadId };
  },
});
