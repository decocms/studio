import { z } from "zod";
import { ForbiddenError } from "@/core/access-control";
import { ConflictError } from "@/core/conflict-error";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "@/core/studio-context";
import type { ChannelAccount } from "@/storage/channel-accounts";

const ChannelAccountSchema = z.object({
  channel: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  accountWhere: z.string().nullable(),
  organizationId: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

const accountView = (a: ChannelAccount) => ({
  channel: a.channel,
  accountId: a.accountId,
  accountName: a.accountName,
  accountWhere: a.accountWhere,
  organizationId: a.organizationId,
  createdAt: a.createdAt,
  lastUsedAt: a.lastUsedAt,
});

const USED = "This link was already used or has expired.";

async function caller(ctx: StudioContext) {
  requireAuth(ctx);
  const org = requireOrganization(ctx);
  await ctx.access.check();
  const userId = getUserId(ctx);
  if (!userId) throw new Error("Unable to determine user ID");
  return { userId, org };
}

/**
 * Connecting says "this account acts as me". Only the person does that,
 * in their own browser session: an agent run or a key acting for them must
 * not, or a link slipped into a prompt would connect someone else's account.
 */
function requireOwnSession(ctx: StudioContext) {
  if (ctx.auth.method !== "session") {
    throw new ForbiddenError(
      "Connect a channel account from Studio, signed in.",
    );
  }
}

export const CHANNEL_ACCOUNT_CLAIM_GET = defineTool({
  name: "CHANNEL_ACCOUNT_CLAIM_GET",
  description:
    "Read a connect link a channel bot sent the caller: which channel account it would connect to them. Null when it was used or expired.",
  annotations: {
    title: "Get Channel Connect Link",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ id: z.string().min(1).max(100) }),
  outputSchema: z.object({
    claim: z
      .object({
        channel: z.string(),
        accountName: z.string(),
        accountWhere: z.string().nullable(),
        accountEmail: z.string().nullable(),
        expiresAt: z.string(),
      })
      .nullable(),
  }),
  handler: async (input, ctx) => {
    const { org } = await caller(ctx);
    const claim = await ctx.storage.channelAccounts.getClaim(org.id, input.id);
    return {
      claim: claim && {
        channel: claim.channel,
        accountName: claim.accountName,
        accountWhere: claim.accountWhere,
        accountEmail: claim.accountEmail,
        expiresAt: claim.expiresAt,
      },
    };
  },
});

export const CHANNEL_ACCOUNT_CONNECT = defineTool({
  name: "CHANNEL_ACCOUNT_CONNECT",
  description:
    "Connect the channel account of a connect link to the caller: bots in that channel then act as the caller when that account writes to them. Only from the caller's own Studio session.",
  annotations: {
    title: "Connect Channel Account",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({ id: z.string().min(1).max(100) }),
  outputSchema: z.object({
    account: ChannelAccountSchema,
    returnUrl: z.string(),
  }),
  handler: async (input, ctx) => {
    const { userId, org } = await caller(ctx);
    requireOwnSession(ctx);
    const claim = await ctx.storage.channelAccounts.getClaim(org.id, input.id);
    if (!claim) throw new ConflictError(USED);
    if (claim.accountEmail) {
      // The channel says whose account it is: a link passed to someone else
      // stops here.
      const user = await ctx.db
        .selectFrom("user")
        .select("email")
        .where("id", "=", userId)
        .executeTakeFirst();
      if (user?.email.trim().toLowerCase() !== claim.accountEmail) {
        throw new ForbiddenError(
          "This channel account belongs to another email.",
        );
      }
    }
    const connected = await ctx.storage.channelAccounts.connect(
      org.id,
      input.id,
      userId,
    );
    if (!connected) throw new ConflictError(USED);
    return {
      account: accountView(connected.account),
      returnUrl: connected.returnUrl,
    };
  },
});

export const CHANNEL_ACCOUNT_LIST = defineTool({
  name: "CHANNEL_ACCOUNT_LIST",
  description:
    "List the channel accounts (Slack, Discord…) connected to the caller: bots there act as the caller when one of them writes.",
  annotations: {
    title: "List My Channel Accounts",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({ accounts: z.array(ChannelAccountSchema) }),
  handler: async (_, ctx) => {
    const { userId } = await caller(ctx);
    const accounts = await ctx.storage.channelAccounts.listForUser(userId);
    return { accounts: accounts.map(accountView) };
  },
});

export const CHANNEL_ACCOUNT_DISCONNECT = defineTool({
  name: "CHANNEL_ACCOUNT_DISCONNECT",
  description:
    "Disconnect one of the caller's channel accounts: bots in that channel stop acting as the caller.",
  annotations: {
    title: "Disconnect Channel Account",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    channel: z.string().min(1).max(32),
    accountId: z.string().min(1).max(200),
  }),
  outputSchema: z.object({ disconnected: z.boolean() }),
  handler: async (input, ctx) => {
    const { userId } = await caller(ctx);
    return {
      disconnected: await ctx.storage.channelAccounts.disconnectOwn(
        userId,
        input,
      ),
    };
  },
});
