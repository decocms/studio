import type { Kysely } from "kysely";
import type { Database, OrganizationDomain } from "./types";
import type { OrganizationDomainStoragePort } from "./ports";

function toEntity(
  record: Record<string, unknown> & {
    organization_id: string;
    domain: string;
    auto_join_enabled: boolean;
    created_at: Date;
    updated_at: Date;
  },
): OrganizationDomain {
  return {
    organizationId: record.organization_id,
    domain: record.domain,
    autoJoinEnabled: record.auto_join_enabled,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export class OrganizationDomainStorage
  implements OrganizationDomainStoragePort
{
  constructor(private readonly db: Kysely<Database>) {}

  async getAllByDomain(domain: string): Promise<OrganizationDomain[]> {
    const records = await this.db
      .selectFrom("organization_domains")
      .selectAll()
      .where("domain", "=", domain.toLowerCase())
      .execute();

    return records.map(toEntity);
  }

  async getByOrganizationId(
    organizationId: string,
  ): Promise<OrganizationDomain | null> {
    const record = await this.db
      .selectFrom("organization_domains")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    return record ? toEntity(record) : null;
  }

  async setDomain(
    organizationId: string,
    domain: string,
    autoJoinEnabled = false,
  ): Promise<OrganizationDomain> {
    const now = new Date().toISOString();
    const normalizedDomain = domain.toLowerCase();

    await this.db
      .insertInto("organization_domains")
      .values({
        organization_id: organizationId,
        domain: normalizedDomain,
        auto_join_enabled: autoJoinEnabled,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column("organization_id").doUpdateSet({
          domain: normalizedDomain,
          auto_join_enabled: autoJoinEnabled,
          updated_at: now,
        }),
      )
      .execute();

    const result = await this.getByOrganizationId(organizationId);
    if (!result) {
      throw new Error("Failed to set domain");
    }
    return result;
  }

  async updateAutoJoin(
    organizationId: string,
    autoJoinEnabled: boolean,
  ): Promise<OrganizationDomain> {
    const now = new Date().toISOString();

    await this.db
      .updateTable("organization_domains")
      .set({
        auto_join_enabled: autoJoinEnabled,
        updated_at: now,
      })
      .where("organization_id", "=", organizationId)
      .execute();

    const result = await this.getByOrganizationId(organizationId);
    if (!result) {
      throw new Error("No domain found for organization");
    }
    return result;
  }

  async clearDomain(organizationId: string): Promise<void> {
    await this.db
      .deleteFrom("organization_domains")
      .where("organization_id", "=", organizationId)
      .execute();
  }
}
