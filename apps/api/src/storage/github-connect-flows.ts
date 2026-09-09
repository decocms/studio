import type { Kysely } from "kysely";
import type { Database } from "./types";
import {
  GitProviderAccountStorage,
  type UpsertGitProviderAccountParams,
} from "./git-provider-accounts";

type FlowOwner = { organizationId: string; userId: string };

/** Short-lived, encrypted user grants used only while choosing an installation. */
export class GithubConnectFlowStorage {
  constructor(private readonly db: Kysely<Database>) {}

  async create(
    owner: FlowOwner,
    encryptedAccessToken: string,
  ): Promise<string> {
    await this.db
      .deleteFrom("github_connect_flows")
      .where("expires_at", "<=", new Date())
      .execute();
    // Keep at most one pending flow per user/workspace, including abandoned tabs.
    return this.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom("organization")
        .select("id")
        .where("id", "=", owner.organizationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await trx
        .deleteFrom("github_connect_flows")
        .where("organization_id", "=", owner.organizationId)
        .where("user_id", "=", owner.userId)
        .execute();
      const id = crypto.randomUUID();
      await trx
        .insertInto("github_connect_flows")
        .values({
          id,
          organization_id: owner.organizationId,
          user_id: owner.userId,
          encrypted_access_token: encryptedAccessToken,
          expires_at: new Date(Date.now() + 10 * 60_000),
        })
        .execute();
      return id;
    });
  }

  async get(id: string, owner: FlowOwner) {
    return this.db
      .selectFrom("github_connect_flows")
      .selectAll()
      .where("id", "=", id)
      .where("organization_id", "=", owner.organizationId)
      .where("user_id", "=", owner.userId)
      .where("expires_at", ">", new Date())
      .executeTakeFirst();
  }

  async refresh(
    id: string,
    owner: FlowOwner,
    encryptedAccessToken: string,
  ): Promise<boolean> {
    const result = await this.db
      .updateTable("github_connect_flows")
      .set({ encrypted_access_token: encryptedAccessToken })
      .where("id", "=", id)
      .where("organization_id", "=", owner.organizationId)
      .where("user_id", "=", owner.userId)
      .where("expires_at", ">", new Date())
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async cancel(id: string, owner: FlowOwner) {
    await this.db
      .deleteFrom("github_connect_flows")
      .where("id", "=", id)
      .where("organization_id", "=", owner.organizationId)
      .where("user_id", "=", owner.userId)
      .execute();
  }

  async connect(
    id: string,
    owner: FlowOwner,
    account: UpsertGitProviderAccountParams,
  ) {
    return this.db.transaction().execute(async (trx) => {
      const flow = await trx
        .deleteFrom("github_connect_flows")
        .where("id", "=", id)
        .where("organization_id", "=", owner.organizationId)
        .where("user_id", "=", owner.userId)
        .where("expires_at", ">", new Date())
        .returning("id")
        .executeTakeFirst();
      if (!flow) return null;
      return new GitProviderAccountStorage(trx).upsert({
        ...account,
        organizationId: owner.organizationId,
        createdBy: owner.userId,
      });
    });
  }
}
