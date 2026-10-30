import { CAMPAIGN_SEED_KEY_PREFIX } from "@decocms/shared/blog-campaign";
import { type BlogJob, blogJobOfThread } from "@decocms/shared/blog-job";
import { agentSandboxEnabled } from "@/settings";
import { getUserId, type StudioContext } from "../../core/studio-context";
import { taskRunContextStore } from "../task-board/task-run-context";

export type CampaignsJob = Extract<BlogJob, { kind: "campaigns" }>;

/** The chat whose run is calling, or null for a person; a sandboxed run reaches Studio on its thread's MCP endpoint. */
export function callerRunThread(ctx: StudioContext): string | null {
  return (
    taskRunContextStore.getStore()?.threadId ?? ctx.metadata?.threadId ?? null
  );
}

/** The person starting a blog job: a run, a deployment without a sandbox or a caller without a user cannot. */
export function blogJobStarter(ctx: StudioContext, what: string): string {
  if (callerRunThread(ctx)) {
    throw new Error(`A run cannot start ${what}; a person does.`);
  }
  if (!agentSandboxEnabled()) {
    throw new Error(`This deployment has no sandbox to run ${what} in.`);
  }
  const userId = getUserId(ctx);
  if (!userId) throw new Error(`Starting ${what} needs a person.`);
  return userId;
}

/** The blog job a calling run works, or null for a person or any other chat. */
export async function callerBlogJob(
  ctx: StudioContext,
): Promise<BlogJob | null> {
  const threadId = callerRunThread(ctx);
  if (!threadId) return null;
  const thread = await ctx.storage.threads.get(threadId).catch(() => null);
  return blogJobOfThread(thread?.metadata);
}

function hasGoal(goal: unknown): boolean {
  if (!goal || typeof goal !== "object") return false;
  const { text, metric, target } = goal as Record<string, unknown>;
  return (
    (typeof text === "string" && text.trim() !== "") ||
    (typeof target === "string" && target.trim() !== "") ||
    (typeof metric === "string" && metric !== "")
  );
}

/** Why a campaigns chat may not make this write, or null when it may: it writes only its own drafts. */
export function campaignsJobRefusal(
  job: CampaignsJob,
  write: {
    campaigns: readonly { id: string; data: Record<string, unknown> }[];
    seeds: number;
    removals: number;
  },
  stored: ReadonlyMap<string, Record<string, unknown> | null>,
): string | null {
  if (write.seeds > 0) {
    return "A campaigns chat never writes a seed: the seed is the person's.";
  }
  if (write.removals > 0) {
    return "A campaigns chat never removes a campaign or a seed: a person does.";
  }
  const seedKey = `${CAMPAIGN_SEED_KEY_PREFIX}${job.seedId}`;
  const ids = job.campaignIds.map((id) => `\`${id}\``).join(", ");
  for (const { id, data } of write.campaigns) {
    if (!job.campaignIds.includes(id)) {
      return `\`${id}\` is not one of this chat's campaigns. Write only under ${ids}.`;
    }
    if (data.status !== "draft") {
      return `Write \`${id}\` with \`status: "draft"\`: activating a campaign is a person's.`;
    }
    if (data.seedKey !== seedKey) {
      return `Write \`${id}\` with \`seedKey: "${seedKey}"\`.`;
    }
    if (hasGoal(data.goal)) {
      return `Write \`${id}\` without a goal: a person sets it.`;
    }
    const before = stored.get(id);
    if (before && (before.status !== "draft" || hasGoal(before.goal))) {
      return `\`${id}\` is a person's now: it was activated or given a goal. Leave it as it is.`;
    }
  }
  return null;
}
