/**
 * Linking a user's GitHub Copilot plan to their sandbox-hosted `claude-code`
 * runs. Copilot serves Claude models on an Anthropic-compatible
 * `/v1/messages`, which the CLI reaches with the user's GitHub token as a
 * bearer — no token exchange and no borrowed editor client id.
 *
 * The token is a fine-grained personal access token with the "Copilot
 * Requests" permission, the credential GitHub documents for Copilot CLI. It
 * is the user's own seat, so it is stored per user and never shared.
 */

import z from "zod";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "../../core/studio-context";
import { GITHUB_COPILOT_PROVIDER_ID } from "../../harnesses/claude-code-env";

const statusSchema = z.object({
  connected: z.boolean(),
  linkedAt: z.string().nullable(),
  orgShare: z
    .object({
      sharedBy: z.object({ id: z.string(), name: z.string().nullable() }),
      sharedByMe: z.boolean(),
    })
    .nullable()
    .describe("The plan shared with this org, which every run here uses first"),
});

/** The org's shared Copilot plan: the oldest share, the one dispatch uses. */
async function orgShare(
  ctx: StudioContext,
  organizationId: string,
  userId: string,
) {
  const plans = await ctx.storage.orgSharedPlans.list(organizationId);
  const plan = plans.find((p) => p.providerId === GITHUB_COPILOT_PROVIDER_ID);
  return plan
    ? {
        sharedBy: { id: plan.userId, name: plan.userName },
        sharedByMe: plan.userId === userId,
      }
    : null;
}

/** Classic PATs are refused by Copilot (GitHub's Copilot CLI auth docs). */
const CLASSIC_PAT_PREFIX = "ghp_";

/** Returns the token to store, or throws with what the user should do instead. */
export function normalizeCopilotToken(pasted: string): string {
  const token = pasted.trim();
  if (token.length === 0) throw new Error("The token must not be empty");
  if (/\s/.test(token)) {
    throw new Error("The token must not contain spaces or line breaks");
  }
  if (token.startsWith(CLASSIC_PAT_PREFIX)) {
    throw new Error(
      "Classic personal access tokens do not work with Copilot. Create a " +
        "fine-grained token with the Copilot Requests permission.",
    );
  }
  return token;
}

export const GITHUB_COPILOT_CONNECT = defineTool({
  name: "GITHUB_COPILOT_CONNECT",
  description:
    "Link the caller's GitHub Copilot plan with a fine-grained personal " +
    "access token, so their claude-code runs use Claude through Copilot. " +
    "Stored encrypted, for the caller only.",
  inputSchema: z.object({
    token: z
      .string()
      .min(1)
      .max(4096)
      .describe(
        "A fine-grained GitHub token (github_pat_…) with the Copilot Requests permission",
      ),
  }),
  outputSchema: statusSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const { linkedAt } = await ctx.storage.githubCopilotSubscriptions.upsert({
      userId,
      accessToken: normalizeCopilotToken(input.token),
    });
    return {
      connected: true,
      linkedAt,
      orgShare: await orgShare(ctx, organization.id, userId),
    };
  },
});

export const GITHUB_COPILOT_STATUS = defineTool({
  name: "GITHUB_COPILOT_STATUS",
  description: "Whether the caller has linked a GitHub Copilot token.",
  inputSchema: z.object({}),
  outputSchema: statusSchema,
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const found = await ctx.storage.githubCopilotSubscriptions.find(userId);
    return {
      connected: found !== null,
      linkedAt: found?.linkedAt ?? null,
      orgShare: await orgShare(ctx, organization.id, userId),
    };
  },
});

export const GITHUB_COPILOT_DISCONNECT = defineTool({
  name: "GITHUB_COPILOT_DISCONNECT",
  description: "Unlink the caller's GitHub Copilot token and delete it.",
  inputSchema: z.object({}),
  outputSchema: statusSchema,
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    await ctx.storage.githubCopilotSubscriptions.delete(userId);
    // The share points at this token; without it the share means nothing.
    await ctx.storage.orgSharedPlans.unshareEverywhere(
      GITHUB_COPILOT_PROVIDER_ID,
      userId,
    );
    return {
      connected: false,
      linkedAt: null,
      orgShare: await orgShare(ctx, organization.id, userId),
    };
  },
});

export const GITHUB_COPILOT_SHARE = defineTool({
  name: "GITHUB_COPILOT_SHARE",
  description:
    "Share (or stop sharing) the caller's linked GitHub Copilot plan with " +
    "this organization. While shared, every sandbox run in the org uses it " +
    "first, ahead of members' own plans and the org's model key.",
  inputSchema: z.object({ shared: z.boolean() }),
  outputSchema: statusSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const found = await ctx.storage.githubCopilotSubscriptions.find(userId);
    if (input.shared) {
      if (!found) throw new Error("Link your GitHub Copilot plan first");
      await ctx.storage.orgSharedPlans.share(
        organization.id,
        GITHUB_COPILOT_PROVIDER_ID,
        userId,
      );
    } else {
      await ctx.storage.orgSharedPlans.unshare(
        organization.id,
        GITHUB_COPILOT_PROVIDER_ID,
        userId,
      );
    }
    return {
      connected: found !== null,
      linkedAt: found?.linkedAt ?? null,
      orgShare: await orgShare(ctx, organization.id, userId),
    };
  },
});
