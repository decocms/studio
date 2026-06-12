import type { Kysely } from "kysely";
import type { Database } from "@/storage/types";

/**
 * Synthetic bot identity for a channel.
 *
 * Each channel registers one bot that acts as an org member. The Decopilot
 * agent run resolves identity through the background context factory, which
 * only needs a `member` row (joined to `organization`) — it never reads other
 * `user` fields. So a bot is just a `user` row (for FK integrity) plus a
 * `member` row.
 *
 * We insert both rows directly rather than going through Better Auth's signup
 * API: `auth.api.signUpEmail` / `createUser` trigger the `user.create.after`
 * hook, which auto-creates a stray personal organization for the new account.
 * The bot never authenticates, so it needs no password/account row.
 */

const BOT_EMAIL_DOMAIN = "channels.studio.local";

function botEmailFor(channelId: string): string {
  return `bot+${channelId}@${BOT_EMAIL_DOMAIN}`;
}

export async function ensureChannelBot(params: {
  db: Kysely<Database>;
  organizationId: string;
  channelId: string;
  displayName: string;
}): Promise<{ botUserId: string }> {
  const { db, organizationId, channelId, displayName } = params;
  const email = botEmailFor(channelId);
  const now = new Date().toISOString();

  // Reuse an existing bot user for this channel if one already exists (idempotent).
  const existing = await db
    .selectFrom("user")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirst();

  const botUserId = existing?.id ?? crypto.randomUUID();

  if (!existing) {
    await db
      .insertInto("user")
      .values({
        id: botUserId,
        email,
        emailVerified: 1,
        name: displayName,
        image: null,
        role: null,
        banned: null,
        banReason: null,
        banExpires: null,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
  }

  // Ensure org membership (role "user" — least privilege; can run agent turns
  // exactly like automations).
  const member = await db
    .selectFrom("member")
    .select("id")
    .where("userId", "=", botUserId)
    .where("organizationId", "=", organizationId)
    .executeTakeFirst();

  if (!member) {
    await db
      .insertInto("member")
      .values({
        id: crypto.randomUUID(),
        organizationId,
        userId: botUserId,
        role: "user",
        createdAt: now,
      })
      .execute();
  }

  return { botUserId };
}

/**
 * Tear down a channel's bot identity. Removes the org membership and the
 * synthetic user row. Best-effort: failures are swallowed so channel deletion
 * still succeeds.
 */
export async function removeChannelBot(params: {
  db: Kysely<Database>;
  organizationId: string;
  botUserId: string;
}): Promise<void> {
  const { db, organizationId, botUserId } = params;
  try {
    await db
      .deleteFrom("member")
      .where("userId", "=", botUserId)
      .where("organizationId", "=", organizationId)
      .execute();
    await db.deleteFrom("user").where("id", "=", botUserId).execute();
  } catch (err) {
    console.warn(
      "[channels] failed to remove bot identity",
      botUserId,
      err instanceof Error ? err.message : err,
    );
  }
}
