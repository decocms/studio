import type { Kysely } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type { Database, OrgSsoConfig, OrgSsoConfigPublic } from "./types";

export class OrgSsoConfigStorage {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly vault: CredentialVault,
  ) {}

  async getByOrgId(organizationId: string): Promise<OrgSsoConfig | null> {
    const record = await this.db
      .selectFrom("org_sso_config")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    if (!record) return null;
    return this.toRuntime(record);
  }

  async getByDomain(domain: string): Promise<OrgSsoConfig | null> {
    const record = await this.db
      .selectFrom("org_sso_config")
      .selectAll()
      .where("domain", "=", domain.toLowerCase())
      .executeTakeFirst();

    if (!record) return null;
    return this.toRuntime(record);
  }

  async upsert(
    organizationId: string,
    data: {
      issuer: string;
      clientId: string;
      clientSecret: string;
      discoveryEndpoint?: string | null;
      scopes?: string[];
      domain: string;
      enforced?: boolean;
    },
  ): Promise<OrgSsoConfig> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const encryptedSecret = await this.vault.encrypt(data.clientSecret);
    const scopesJson = JSON.stringify(
      data.scopes ?? ["openid", "email", "profile"],
    );

    await this.db
      .insertInto("org_sso_config")
      .values({
        id,
        organization_id: organizationId,
        issuer: data.issuer,
        client_id: data.clientId,
        client_secret: encryptedSecret,
        discovery_endpoint: data.discoveryEndpoint ?? null,
        scopes: scopesJson,
        domain: data.domain.toLowerCase(),
        enforced: data.enforced ? 1 : 0,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column("organization_id").doUpdateSet({
          issuer: data.issuer,
          client_id: data.clientId,
          client_secret: encryptedSecret,
          discovery_endpoint: data.discoveryEndpoint ?? null,
          scopes: scopesJson,
          domain: data.domain.toLowerCase(),
          enforced: data.enforced ? 1 : 0,
          updated_at: now,
        }),
      )
      .execute();

    const result = await this.getByOrgId(organizationId);
    if (!result) throw new Error("Failed to upsert org SSO config");
    return result;
  }

  async setEnforced(organizationId: string, enforced: boolean): Promise<void> {
    await this.db
      .updateTable("org_sso_config")
      .set({ enforced: enforced ? 1 : 0, updated_at: new Date().toISOString() })
      .where("organization_id", "=", organizationId)
      .execute();
  }

  async delete(organizationId: string): Promise<void> {
    await this.db
      .deleteFrom("org_sso_config")
      .where("organization_id", "=", organizationId)
      .execute();
  }

  toPublic(config: OrgSsoConfig): OrgSsoConfigPublic {
    const { clientSecret: _, ...rest } = config;
    return rest;
  }

  private async toRuntime(
    record: Record<string, unknown>,
  ): Promise<OrgSsoConfig> {
    const decryptedSecret = await this.vault.decrypt(
      record.client_secret as string,
    );
    const scopes =
      typeof record.scopes === "string"
        ? JSON.parse(record.scopes)
        : record.scopes;

    return {
      id: record.id as string,
      organizationId: record.organization_id as string,
      issuer: record.issuer as string,
      clientId: record.client_id as string,
      clientSecret: decryptedSecret,
      discoveryEndpoint: record.discovery_endpoint as string | null,
      scopes,
      domain: record.domain as string,
      enforced: record.enforced === 1,
      createdAt: record.created_at as string,
      updatedAt: record.updated_at as string,
    };
  }
}
