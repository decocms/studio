import {
  CAMPAIGN_SEED_KEY_PREFIX,
  MAX_PROPOSED_CAMPAIGNS,
} from "@decocms/shared/blog-campaign";
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import {
  CAMPAIGN_SEEDS_DIR,
  readBlogRecord,
  recordPath,
  writeBlogFiles,
} from "../../file-storage/blog-state";
import { notifyOrgFsChangeFromServer } from "../../file-storage/org-fs-notify";
import { blogJobStarter, type CampaignsJob } from "./blog-job";
import { RecordIdSchema, resolveBlogScope } from "./state";
import { openBlogJobChat } from "./super-agent-turn";

/**
 * Campaigns proposed by the content track's agent, in a chat of its own.
 *
 * Claude Code reads the store's systems in a sandbox, on the organization's
 * model or the person's own Claude plan, and writes each campaign as a draft
 * under an id minted here. The person reviews them on the board, sets the goal
 * and activates the ones worth running.
 */

const MAX_SEED_NAME_CHARS = 60;

const SeedSchema = z.object({
  id: RecordIdSchema.optional().describe(
    "A saved seed's id, to run it again, or one the caller minted, so a retried start rewrites the same seed. Without it a new seed is minted.",
  ),
  name: z.string().trim().max(120).default(""),
  keywords: z.array(z.string().trim().max(200)).max(50).default([]),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(4_000)
    .describe("What the moment is, in the person's own words."),
});

/** The rules every turn of a campaigns chat runs under. */
export function blogCampaignsInstructions(job: CampaignsJob): string {
  const seedKey = `${CAMPAIGN_SEED_KEY_PREFIX}${job.seedId}`;
  const ids = job.campaignIds.map((id) => `\`${id}\``).join(", ");
  return [
    "You propose blog campaigns for this organization's content track, from one seed, and nothing else.",
    "",
    `- The brand folder is \`home/brands/${job.brand}/\`. Read the brand, its campaigns and the seed \`${job.seedId}\` with BLOG_STATE_GET at the start of every turn.`,
    "- Follow `campaigns.md` in the `blogpost` skill.",
    `- Write each campaign with BLOG_STATE_SET, one call each, under these ids, in order: ${ids}. Fewer is fine; never another id.`,
    `- Write every campaign with \`status: "draft"\`, \`seedKey: "${seedKey}"\` and no \`goal\`. Activating a campaign and setting its goal are a person's.`,
    "- Never write or remove any other campaign, and never write a seed.",
    "- Write in the brand's language, whatever language you are spoken to in.",
    "- Your Studio tools are namespaced `mcp__studio__`: where this names `BLOG_STATE_SET`, the tool you call is `mcp__studio__BLOG_STATE_SET`.",
  ].join("\n");
}

/** The turn that starts a proposal: a fixed ask, then the seed as the person wrote it. */
export function blogCampaignsPrompt(
  seed: { name: string; keywords: string[]; prompt: string },
  count: number,
): string {
  const lines = [
    `Propose at most ${count} campaign(s) from this seed: follow \`campaigns.md\` in the \`blogpost\` skill. Save each as a draft as soon as it is ready, then present them here and wait.`,
    "",
    "The seed, from the person:",
  ];
  if (seed.name) lines.push(`Name: ${seed.name}`);
  if (seed.keywords.length > 0) {
    lines.push(`Terms to aim at: ${seed.keywords.join(", ")}`);
  }
  lines.push("", seed.prompt);
  return lines.join("\n");
}

export const BLOG_CAMPAIGNS_PROPOSE = defineTool({
  name: "BLOG_CAMPAIGNS_PROPOSE",
  description:
    "Start a chat where the content track's agent proposes blog campaigns from a seed (a sentence about the moment, plus terms), reading the store's VTEX, GA4 and Search Console in a sandbox. Saves the seed and returns the chat with the ids its drafts will have; the campaigns arrive as drafts as the agent writes them.",
  annotations: {
    title: "Propose Campaigns",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },

  inputSchema: z.object({
    seed: SeedSchema,
    count: z
      .number()
      .int()
      .min(1)
      .max(MAX_PROPOSED_CAMPAIGNS)
      .default(MAX_PROPOSED_CAMPAIGNS)
      .describe("The most campaigns to propose. Fewer is a valid answer."),
  }),

  outputSchema: z.object({
    threadId: z
      .string()
      .describe("The proposal's chat, to open beside the page."),
    seedId: z.string().describe("The seed's id, saved before the chat starts."),
    campaignIds: z
      .array(z.string())
      .describe("The ids the drafts are written under, in order."),
  }),

  requiresAiBudget: true,

  modelSummary: (r) =>
    `Proposing up to ${r.campaignIds.length} campaign(s) in chat ${r.threadId}.`,

  handler: async (input, ctx) => {
    const { organizationId, orgFs, brand, actor } = await resolveBlogScope(ctx);
    const userId = blogJobStarter(ctx, "a campaigns proposal");

    const seedId = input.seed.id ?? crypto.randomUUID();
    const seedPath = recordPath(brand, CAMPAIGN_SEEDS_DIR, seedId);
    const stored = await readBlogRecord(orgFs, seedPath);
    const now = new Date().toISOString();
    const seedName =
      input.seed.name ||
      (input.seed.prompt.split("\n")[0] ?? "").slice(0, MAX_SEED_NAME_CHARS);
    const keywords = input.seed.keywords.filter(Boolean);
    const createdAt = stored?.data.createdAt;
    await writeBlogFiles(orgFs, actor, [
      {
        path: seedPath,
        data: {
          ...stored?.data,
          seedName,
          keywords,
          prompt: input.seed.prompt,
          createdAt:
            typeof createdAt === "string" && createdAt ? createdAt : now,
          updatedAt: now,
        },
      },
    ]);
    await notifyOrgFsChangeFromServer(organizationId, HOME_MOUNT_PATH, [
      seedPath,
    ]);

    const job: CampaignsJob = {
      kind: "campaigns",
      brand,
      seedId,
      campaignIds: Array.from({ length: input.count }, () =>
        crypto.randomUUID(),
      ),
    };
    const threadId = await openBlogJobChat(ctx, {
      organizationId,
      userId,
      job,
      title: seedName,
      text: blogCampaignsPrompt(
        { name: input.seed.name, keywords, prompt: input.seed.prompt },
        input.count,
      ),
      instructions: blogCampaignsInstructions(job),
    });
    return { threadId, seedId, campaignIds: job.campaignIds };
  },
});
