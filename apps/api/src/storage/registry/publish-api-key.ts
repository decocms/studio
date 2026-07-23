import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { PrivateRegistryDatabase, PublishApiKeyEntity } from "./types";

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function generateApiKey(): string {
  return `prk_${randomBytes(32).toString("hex")}`;
}

export class PublishApiKeyStorage {
  constructor(private db: Kysely<PrivateRegistryDatabase>) {}

  /**
   * Generate a new API key, store its hash, and return the plaintext key (shown only once).
   */
  async generate(
    organizationId: string,
    name: string,
  ): Promise<{ entity: PublishApiKeyEntity; key: string }> {
    const id = randomUUID();
    const key = generateApiKey();
    const keyHash = await hashApiKey(key);
    const prefix = key.slice(0, 12); // "prk_XXXXXXXX" (enough to identify)
    const now = new Date().toISOString();

    await this.db
      .insertInto("private_registry_publish_api_key")
      .values({
        id,
        organization_id: organizationId,
        name,
        key_hash: keyHash,
        prefix,
        created_at: now,
      })
      .execute();

    return {
      entity: {
        id,
        organization_id: organizationId,
        name,
        prefix,
        created_at: now,
      },
      key,
    };
  }

  /**
   * List all API keys for an organization (metadata only, no key values).
   */
  async list(organizationId: string): Promise<PublishApiKeyEntity[]> {
    const rows = await this.db
      .selectFrom("private_registry_publish_api_key")
      .select(["id", "organization_id", "name", "prefix", "created_at"])
      .where("organization_id", "=", organizationId)
      .orderBy("created_at", "desc")
      .execute();

    return rows;
  }

  /**
   * Revoke (delete) an API key by ID.
   */
  async revoke(organizationId: string, keyId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom("private_registry_publish_api_key")
      .where("organization_id", "=", organizationId)
      .where("id", "=", keyId)
      .execute();

    return result.length > 0;
  }

  /**
   * Validate an API key against stored hashes for an organization.
   * Returns true if the key is valid.
   */
  async validate(
    organizationId: string,
    plaintextKey: string,
  ): Promise<boolean> {
    const keyHash = await hashApiKey(plaintextKey);

    const row = await this.db
      .selectFrom("private_registry_publish_api_key")
      .select(["id"])
      .where("organization_id", "=", organizationId)
      .where("key_hash", "=", keyHash)
      .executeTakeFirst();

    return Boolean(row);
  }

  /**
   * Check if an organization has any API keys configured.
   */
  async hasKeys(organizationId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("private_registry_publish_api_key")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();

    return Number(row?.count ?? 0) > 0;
  }
}
