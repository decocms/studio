import type { Kysely, Selectable } from "kysely";
import type { OrganizationInviteLinkStoragePort } from "./ports";
import type {
  Database,
  OrganizationInviteLink,
  OrganizationInviteLinkTable,
} from "./types";

function toEntity(
  row: Selectable<OrganizationInviteLinkTable>,
): OrganizationInviteLink {
  return {
    id: row.id,
    organizationId: row.organization_id,
    role: row.role,
    redirectPath: row.redirect_path,
    createdBy: row.created_by,
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    useCount: row.use_count,
    createdAt: new Date(row.created_at),
  };
}

export class OrganizationInviteLinkStorage
  implements OrganizationInviteLinkStoragePort
{
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: {
    organizationId: string;
    tokenHash: string;
    role: string;
    redirectPath: string | null;
    createdBy: string | null;
    expiresAt: Date;
  }): Promise<OrganizationInviteLink> {
    const row = await this.db
      .insertInto("organization_invite_links")
      .values({
        id: crypto.randomUUID(),
        organization_id: input.organizationId,
        token_hash: input.tokenHash,
        role: input.role,
        redirect_path: input.redirectPath,
        created_by: input.createdBy,
        expires_at: input.expiresAt.toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toEntity(row);
  }

  async listActive(organizationId: string): Promise<OrganizationInviteLink[]> {
    const rows = await this.db
      .selectFrom("organization_invite_links")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", new Date())
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(toEntity);
  }

  async findByTokenHash(
    tokenHash: string,
  ): Promise<OrganizationInviteLink | null> {
    const row = await this.db
      .selectFrom("organization_invite_links")
      .selectAll()
      .where("token_hash", "=", tokenHash)
      .executeTakeFirst();
    return row ? toEntity(row) : null;
  }

  async revoke(id: string, organizationId: string): Promise<boolean> {
    const res = await this.db
      .updateTable("organization_invite_links")
      .set({ revoked_at: new Date().toISOString() })
      .where("id", "=", id)
      .where("organization_id", "=", organizationId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return res.numUpdatedRows > 0n;
  }

  async incrementUse(id: string): Promise<void> {
    await this.db
      .updateTable("organization_invite_links")
      .set((eb) => ({ use_count: eb("use_count", "+", 1) }))
      .where("id", "=", id)
      .execute();
  }
}
