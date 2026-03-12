import type { Kysely } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type { Database, ProviderKeyInfo } from "./types";
import type { ProviderId } from "@decocms/mesh-sdk";
import { generatePrefixedId } from "@/shared/utils/generate-id";

export class AIProviderKeyStorage {
  constructor(
    private db: Kysely<Database>,
    private vault: CredentialVault,
  ) {}

  private rowToKeyInfo(row: {
    id: string;
    provider_id: string;
    label: string;
    organization_id: string;
    created_by: string;
    created_at: Date | string;
  }): ProviderKeyInfo {
    return {
      id: row.id,
      providerId: row.provider_id as ProviderId,
      label: row.label,
      organizationId: row.organization_id,
      createdBy: row.created_by,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    };
  }

  async create(params: {
    providerId: ProviderId;
    label: string;
    apiKey: string; // plaintext — will be encrypted before storage
    organizationId: string;
    createdBy: string;
  }): Promise<ProviderKeyInfo> {
    const id = generatePrefixedId("aik");
    const encryptedApiKey = await this.vault.encrypt(params.apiKey);
    const createdAt = new Date();

    await this.db
      .insertInto("ai_provider_keys")
      .values({
        id,
        organization_id: params.organizationId,
        provider_id: params.providerId,
        label: params.label,
        encrypted_api_key: encryptedApiKey,
        created_by: params.createdBy,
        created_at: createdAt,
      })
      .execute();

    return this.rowToKeyInfo({
      id,
      provider_id: params.providerId,
      label: params.label,
      organization_id: params.organizationId,
      created_by: params.createdBy,
      created_at: createdAt,
    });
  }

  async list(params: {
    organizationId: string;
    providerId?: ProviderId;
  }): Promise<ProviderKeyInfo[]> {
    let query = this.db
      .selectFrom("ai_provider_keys")
      .where("organization_id", "=", params.organizationId)
      .select([
        "id",
        "provider_id",
        "label",
        "organization_id",
        "created_by",
        "created_at",
      ]);

    if (params.providerId) {
      query = query.where("provider_id", "=", params.providerId);
    }

    const rows = await query.orderBy("created_at", "desc").execute();

    return rows.map((row) => this.rowToKeyInfo(row));
  }

  /** Decrypt and return the raw API key. Only call when you need to make provider API calls. */
  async resolve(
    keyId: string,
    organizationId: string,
  ): Promise<{ keyInfo: ProviderKeyInfo; apiKey: string }> {
    const row = await this.db
      .selectFrom("ai_provider_keys")
      .where("id", "=", keyId)
      .where("organization_id", "=", organizationId)
      .selectAll()
      .executeTakeFirstOrThrow();

    const apiKey = await this.vault.decrypt(row.encrypted_api_key);

    return {
      keyInfo: this.rowToKeyInfo(row),
      apiKey,
    };
  }

  async delete(keyId: string, organizationId: string): Promise<void> {
    const result = await this.db
      .deleteFrom("ai_provider_keys")
      .where("id", "=", keyId)
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    if (!result.numDeletedRows) {
      throw new Error(`AI provider key ${keyId} not found`);
    }
  }

  async findById(
    keyId: string,
    organizationId: string,
  ): Promise<ProviderKeyInfo> {
    const row = await this.db
      .selectFrom("ai_provider_keys")
      .where("id", "=", keyId)
      .where("organization_id", "=", organizationId)
      .select([
        "id",
        "provider_id",
        "label",
        "organization_id",
        "created_by",
        "created_at",
      ])
      .executeTakeFirst();
    if (!row) {
      throw new Error("Provider key not found");
    }
    return this.rowToKeyInfo(row);
  }
}
