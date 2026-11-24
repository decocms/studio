import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import { CHANNELS_TOKEN_AUDIENCE, issueStudioToken } from "@/auth/jwt";
import type { StudioContext } from "@/core/studio-context";
import { CHANNEL_CLAIM_TTL_SECONDS } from "@/storage/channel-accounts";
import { bearerToken, safeEqual } from "./credential-vault";

type Variables = {
  studioContext: StudioContext;
};

/** How long a channel token lives; the service asks again when it needs one. */
const CHANNEL_TOKEN_TTL_SECONDS = 5 * 60;

/** Its own secret, so the channels service reaches nothing else internal. */
export function isChannelsServiceToken(token: string): boolean {
  const expected = process.env.CHANNELS_SERVICE_TOKEN;
  return !!expected && safeEqual(token, expected);
}

/**
 * A connect link may only send the person back to the channels service
 * (`CHANNELS_SERVICE_URL`): the same origin, over https.
 */
export function isChannelsReturnUrl(
  url: string,
  serviceUrl = process.env.CHANNELS_SERVICE_URL,
): boolean {
  if (!serviceUrl) return false;
  try {
    const target = new URL(url);
    const service = new URL(serviceUrl);
    return (
      target.origin === service.origin &&
      (target.protocol === "https:" || target.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

const account = {
  channel: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]{0,31}$/),
  account_id: z.string().trim().min(1).max(200),
};

export const channelAccountTokenBodySchema = z.object(account).strict();

export const channelAccountClaimBodySchema = z
  .object({
    ...account,
    account_name: z.string().trim().min(1).max(200),
    account_where: z.string().trim().max(200).optional(),
    account_email: z.email().max(320).optional(),
    return_url: z.url().max(2000),
  })
  .strict();

export const channelAccountDisconnectBodySchema = z.union([
  z.object(account).strict(),
  z
    .object({
      channel: account.channel,
      account_prefix: z.string().trim().min(1).max(200),
    })
    .strict(),
]);

async function requireChannelsServiceToken(
  c: Context<{ Variables: Variables }>,
  next: Next,
) {
  const token = bearerToken(c.req.header("authorization"));
  if (!token || !isChannelsServiceToken(token)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
}

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

/**
 * Service-to-service routes for the channels service (bots in Slack,
 * Discord…). It can open a link for a channel account to be connected, ask
 * for a token that acts as the person behind a connected account, and
 * disconnect accounts of this organization. It can never connect an account
 * to a user: only that user does, signed in (CHANNEL_ACCOUNT_CONNECT).
 */
export const createChannelAccountServiceRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.use("/internal/channel-accounts", requireChannelsServiceToken);
  app.use("/internal/channel-accounts/*", requireChannelsServiceToken);

  app.post("/internal/channel-accounts/claims", async (c) => {
    const ctx = c.get("studioContext");
    const org = ctx.organization;
    if (!org?.id || !org.slug) {
      return c.json({ error: "Organization context required" }, 403);
    }
    const input = await body(c, channelAccountClaimBodySchema);
    if (!input) return c.json({ error: "Invalid request" }, 400);
    if (!isChannelsReturnUrl(input.return_url)) {
      return c.json({ error: "return_url isn't the channels service's" }, 400);
    }
    const claim = await ctx.storage.channelAccounts.createClaim({
      organizationId: org.id,
      channel: input.channel,
      accountId: input.account_id,
      accountName: input.account_name,
      accountWhere: input.account_where,
      accountEmail: input.account_email,
      returnUrl: input.return_url,
    });
    return c.json({
      url: `${ctx.baseUrl}/${org.slug}/connect-channel/${claim.id}`,
      expires_in: CHANNEL_CLAIM_TTL_SECONDS,
    });
  });

  app.post("/internal/channel-accounts/token", async (c) => {
    const ctx = c.get("studioContext");
    const org = ctx.organization;
    if (!org?.id) {
      return c.json({ error: "Organization context required" }, 403);
    }
    const input = await body(c, channelAccountTokenBodySchema);
    if (!input) return c.json({ error: "Invalid request" }, 400);
    const ref = { channel: input.channel, accountId: input.account_id };
    const linked = await ctx.storage.channelAccounts.get(ref);
    // The same answer for "nobody's" and "theirs, but not of this org".
    const notLinked = () => c.json({ error: "not_linked" }, 404);
    if (!linked) return notLinked();
    const orgs = await ctx.db
      .selectFrom("member")
      .innerJoin("organization", "organization.id", "member.organizationId")
      .select(["organization.id", "organization.slug", "organization.name"])
      .where("member.userId", "=", linked.userId)
      .execute();
    if (!orgs.some((o) => o.id === org.id)) return notLinked();
    const user = await ctx.db
      .selectFrom("user")
      .select(["id", "email", "name"])
      .where("id", "=", linked.userId)
      .executeTakeFirst();
    if (!user) return notLinked();
    const token = await issueStudioToken(
      {
        sub: user.id,
        aud: CHANNELS_TOKEN_AUDIENCE,
        user: { id: user.id, email: user.email, name: user.name },
        metadata: {
          studioUrl: ctx.baseUrl,
          connectionId: `channel:${input.channel}`,
          organizationId: org.id,
        },
        // What it may do is the person's own role, read at each request.
        permissions: {},
      },
      `${CHANNEL_TOKEN_TTL_SECONDS}s`,
    );
    await ctx.storage.channelAccounts.touch(ref);
    return c.json({
      token,
      expires_in: CHANNEL_TOKEN_TTL_SECONDS,
      user: { id: user.id, email: user.email, name: user.name },
      orgs,
    });
  });

  app.delete("/internal/channel-accounts", async (c) => {
    const ctx = c.get("studioContext");
    const org = ctx.organization;
    if (!org?.id) {
      return c.json({ error: "Organization context required" }, 403);
    }
    const input = await body(c, channelAccountDisconnectBodySchema);
    if (!input) return c.json({ error: "Invalid request" }, 400);
    const disconnected = await ctx.storage.channelAccounts.disconnectInOrg(
      org.id,
      input.channel,
      "account_id" in input
        ? { accountId: input.account_id }
        : { accountPrefix: input.account_prefix },
    );
    return c.json({ disconnected });
  });

  return app;
};
