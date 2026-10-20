import type { Kysely } from "kysely";
import type { GitProviderKind } from "@decocms/shared/git-providers";
import type { Database } from "./types";

/**
 * `git_provider_oauth_states` (migration 199): single-use proof that a git
 * provider OAuth redirect was started by a known org+user, plus where to send
 * the browser afterwards.
 *
 * The provider echoes back only the opaque id, so the row carries everything
 * the instance-level callback needs to know — including which org and user
 * started the flow, which is why the callback can be outside org scope.
 */

const STATE_TTL_MS = 10 * 60 * 1000;

export interface GitProviderOAuthState {
  organizationId: string;
  userId: string;
  provider: GitProviderKind;
  host: string;
  returnTo: string;
}

export class GitProviderOAuthStateStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Mint a state. Rows are deleted when the flow completes, so the only
   * growth comes from abandoned redirects — pruned here rather than by a cron:
   * the work is one indexed delete scoped to the org that is starting a flow.
   */
  async create(state: GitProviderOAuthState): Promise<string> {
    await this.deleteExpired(state.organizationId);
    const id = crypto.randomUUID();
    await this.db
      .insertInto("git_provider_oauth_states")
      .values({
        id,
        organization_id: state.organizationId,
        user_id: state.userId,
        provider: state.provider,
        host: state.host,
        return_to: state.returnTo,
        expires_at: new Date(Date.now() + STATE_TTL_MS),
      })
      .execute();
    return id;
  }

  /**
   * Atomically read and delete a state (single-use). Null when unknown or
   * expired — an expired row is still deleted, so a stale redirect cannot be
   * replayed after the clock passes it.
   */
  async consume(id: string): Promise<GitProviderOAuthState | null> {
    const row = await this.db
      .deleteFrom("git_provider_oauth_states")
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) return null;
    const expiresAt =
      row.expires_at instanceof Date
        ? row.expires_at
        : new Date(row.expires_at);
    if (expiresAt < new Date()) return null;
    return {
      organizationId: row.organization_id,
      userId: row.user_id,
      provider: row.provider,
      host: row.host,
      returnTo: row.return_to,
    };
  }

  private async deleteExpired(organizationId: string): Promise<void> {
    await this.db
      .deleteFrom("git_provider_oauth_states")
      .where("organization_id", "=", organizationId)
      .where("expires_at", "<", new Date())
      .execute();
  }
}
