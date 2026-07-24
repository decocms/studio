import type { Kysely } from "kysely";
import type { AddDomainInput, OrganizationDomainStoragePort } from "./ports";
import type {
  Database,
  DomainJoinMode,
  DomainVerificationMethod,
  OrganizationDomain,
} from "./types";

function toEntity(
  record: Record<string, unknown> & {
    id: string;
    organization_id: string;
    domain: string;
    join_mode: string;
    verification_status: string;
    verification_method: string | null;
    verification_token: string | null;
    verified_at: Date | string | null;
    created_at: Date;
    updated_at: Date;
  },
): OrganizationDomain {
  return {
    id: record.id,
    organizationId: record.organization_id,
    domain: record.domain,
    joinMode: record.join_mode as DomainJoinMode,
    verificationStatus:
      record.verification_status === "verified" ? "verified" : "pending",
    verificationMethod:
      (record.verification_method as DomainVerificationMethod | null) ?? null,
    verificationToken: record.verification_token,
    verifiedAt: record.verified_at,
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

  async listByOrganizationId(
    organizationId: string,
  ): Promise<OrganizationDomain[]> {
    const records = await this.db
      .selectFrom("organization_domains")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "asc")
      .execute();

    return records.map(toEntity);
  }

  async getById(id: string): Promise<OrganizationDomain | null> {
    const record = await this.db
      .selectFrom("organization_domains")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    return record ? toEntity(record) : null;
  }

  async getByOrgAndDomain(
    organizationId: string,
    domain: string,
  ): Promise<OrganizationDomain | null> {
    const record = await this.db
      .selectFrom("organization_domains")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("domain", "=", domain.toLowerCase())
      .executeTakeFirst();

    return record ? toEntity(record) : null;
  }

  async add(
    organizationId: string,
    domain: string,
    input: AddDomainInput = {},
  ): Promise<OrganizationDomain> {
    const normalizedDomain = domain.toLowerCase();

    // Idempotent: an org can only claim a given domain once.
    const existing = await this.getByOrgAndDomain(
      organizationId,
      normalizedDomain,
    );
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const verificationStatus = input.verificationStatus ?? "pending";

    await this.db
      .insertInto("organization_domains")
      .values({
        id,
        organization_id: organizationId,
        domain: normalizedDomain,
        join_mode: input.joinMode ?? "off",
        verification_status: verificationStatus,
        verification_method: input.verificationMethod ?? null,
        verification_token: input.verificationToken ?? null,
        verified_at: verificationStatus === "verified" ? now : null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const result = await this.getById(id);
    if (!result) {
      throw new Error("Failed to add domain");
    }
    return result;
  }

  async updateJoinMode(
    id: string,
    joinMode: DomainJoinMode,
  ): Promise<OrganizationDomain> {
    await this.db
      .updateTable("organization_domains")
      .set({ join_mode: joinMode, updated_at: new Date().toISOString() })
      .where("id", "=", id)
      .execute();

    const result = await this.getById(id);
    if (!result) {
      throw new Error("Domain not found");
    }
    return result;
  }

  async markVerified(
    id: string,
    method: DomainVerificationMethod,
  ): Promise<OrganizationDomain> {
    const now = new Date().toISOString();
    await this.db
      .updateTable("organization_domains")
      .set({
        verification_status: "verified",
        verification_method: method,
        verification_token: null,
        verified_at: now,
        updated_at: now,
      })
      .where("id", "=", id)
      .execute();

    const result = await this.getById(id);
    if (!result) {
      throw new Error("Domain not found");
    }
    return result;
  }

  async removeById(id: string): Promise<void> {
    await this.db
      .deleteFrom("organization_domains")
      .where("id", "=", id)
      .execute();
  }
}
