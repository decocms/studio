import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import type { Kysely } from "kysely";
import type { Database } from "./types";

export interface ChannelAccountRef {
  channel: string;
  accountId: string;
}

export interface ChannelAccount extends ChannelAccountRef {
  accountName: string;
  accountWhere: string | null;
  userId: string;
  organizationId: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ChannelAccountClaim extends ChannelAccountRef {
  id: string;
  organizationId: string;
  accountName: string;
  accountWhere: string | null;
  accountEmail: string | null;
  returnUrl: string;
  expiresAt: string;
}

export interface NewChannelAccountClaim extends ChannelAccountRef {
  organizationId: string;
  accountName: string;
  accountWhere?: string | null;
  accountEmail?: string | null;
  returnUrl: string;
}

/** How long a connect link lives. */
export const CHANNEL_CLAIM_TTL_SECONDS = 15 * 60;

/** `%` and `_` are literal in an account-id prefix. */
const likePrefix = (prefix: string) =>
  `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Channel accounts and the claims that create them (migration 270). */
export class ChannelAccountStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /** A link for this account, replacing any it had: one live link at a time. */
  async createClaim(
    input: NewChannelAccountClaim,
  ): Promise<ChannelAccountClaim> {
    return this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom("channel_account_claims")
        .where("channel", "=", input.channel)
        .where("account_id", "=", input.accountId)
        .execute();
      const row = await trx
        .insertInto("channel_account_claims")
        .values({
          id: generatePrefixedId("chc"),
          organization_id: input.organizationId,
          channel: input.channel,
          account_id: input.accountId,
          account_name: input.accountName,
          account_where: input.accountWhere ?? null,
          account_email: input.accountEmail?.trim().toLowerCase() || null,
          return_url: input.returnUrl,
          expires_at: new Date(Date.now() + CHANNEL_CLAIM_TTL_SECONDS * 1000),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return claimOf(row);
    });
  }

  /** A claim that can still be spent, in this org. */
  async getClaim(
    organizationId: string,
    id: string,
  ): Promise<ChannelAccountClaim | null> {
    const row = await this.db
      .selectFrom("channel_account_claims")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .where("used_at", "is", null)
      .where("expires_at", ">", new Date())
      .executeTakeFirst();
    return row ? claimOf(row) : null;
  }

  /**
   * Spend a claim: the account becomes `userId`'s. The claim is marked used
   * first and only once, so two clicks, or a click after it expired, link
   * nothing. A link someone else had to this account is replaced.
   */
  async connect(
    organizationId: string,
    claimId: string,
    userId: string,
  ): Promise<{ account: ChannelAccount; returnUrl: string } | null> {
    return this.db.transaction().execute(async (trx) => {
      const claim = await trx
        .updateTable("channel_account_claims")
        .set({ used_at: new Date() })
        .where("id", "=", claimId)
        .where("organization_id", "=", organizationId)
        .where("used_at", "is", null)
        .where("expires_at", ">", new Date())
        .returningAll()
        .executeTakeFirst();
      if (!claim) return null;
      const row = await trx
        .insertInto("channel_accounts")
        .values({
          channel: claim.channel,
          account_id: claim.account_id,
          account_name: claim.account_name,
          account_where: claim.account_where,
          user_id: userId,
          organization_id: organizationId,
        })
        .onConflict((oc) =>
          oc.columns(["channel", "account_id"]).doUpdateSet({
            account_name: claim.account_name,
            account_where: claim.account_where,
            user_id: userId,
            organization_id: organizationId,
            created_at: new Date(),
            last_used_at: null,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return { account: accountOf(row), returnUrl: claim.return_url };
    });
  }

  async get(ref: ChannelAccountRef): Promise<ChannelAccount | null> {
    const row = await this.db
      .selectFrom("channel_accounts")
      .selectAll()
      .where("channel", "=", ref.channel)
      .where("account_id", "=", ref.accountId)
      .executeTakeFirst();
    return row ? accountOf(row) : null;
  }

  async touch(ref: ChannelAccountRef): Promise<void> {
    await this.db
      .updateTable("channel_accounts")
      .set({ last_used_at: new Date() })
      .where("channel", "=", ref.channel)
      .where("account_id", "=", ref.accountId)
      .execute();
  }

  /** A person's own accounts, newest first. */
  async listForUser(userId: string): Promise<ChannelAccount[]> {
    const rows = await this.db
      .selectFrom("channel_accounts")
      .selectAll()
      .where("user_id", "=", userId)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(accountOf);
  }

  /** A person disconnects one of their own accounts. */
  async disconnectOwn(
    userId: string,
    ref: ChannelAccountRef,
  ): Promise<boolean> {
    const res = await this.db
      .deleteFrom("channel_accounts")
      .where("channel", "=", ref.channel)
      .where("account_id", "=", ref.accountId)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    return Number(res.numDeletedRows) > 0;
  }

  /**
   * The channels service disconnects accounts connected in this org: one, or
   * every one under a prefix (a workspace whose bot was removed).
   */
  async disconnectInOrg(
    organizationId: string,
    channel: string,
    which: { accountId: string } | { accountPrefix: string },
  ): Promise<number> {
    let q = this.db
      .deleteFrom("channel_accounts")
      .where("organization_id", "=", organizationId)
      .where("channel", "=", channel);
    q =
      "accountId" in which
        ? q.where("account_id", "=", which.accountId)
        : q.where("account_id", "like", likePrefix(which.accountPrefix));
    const res = await q.executeTakeFirst();
    return Number(res.numDeletedRows);
  }
}

const iso = (d: Date | string) => new Date(d).toISOString();

function accountOf(row: {
  channel: string;
  account_id: string;
  account_name: string;
  account_where: string | null;
  user_id: string;
  organization_id: string;
  created_at: Date;
  last_used_at: Date | null;
}): ChannelAccount {
  return {
    channel: row.channel,
    accountId: row.account_id,
    accountName: row.account_name,
    accountWhere: row.account_where,
    userId: row.user_id,
    organizationId: row.organization_id,
    createdAt: iso(row.created_at),
    lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
  };
}

function claimOf(row: {
  id: string;
  organization_id: string;
  channel: string;
  account_id: string;
  account_name: string;
  account_where: string | null;
  account_email: string | null;
  return_url: string;
  expires_at: Date;
}): ChannelAccountClaim {
  return {
    id: row.id,
    organizationId: row.organization_id,
    channel: row.channel,
    accountId: row.account_id,
    accountName: row.account_name,
    accountWhere: row.account_where,
    accountEmail: row.account_email,
    returnUrl: row.return_url,
    expiresAt: iso(row.expires_at),
  };
}
