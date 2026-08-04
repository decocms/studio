/**
 * Per-org subsidy gateway keys (see billing/subsidized-runs.ts): the key
 * Studio provisions under the gateway org `subsidy:<organization_id>` so
 * subscription-included task runs bill deco with exact per-client
 * attribution. Vault-encrypted at rest like every provider credential.
 */

import type { Kysely } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type { Database } from "./types";

export class SubsidizedGatewayKeyStorage {
  constructor(
    private db: Kysely<Database>,
    private vault: CredentialVault,
  ) {}

  async get(organizationId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("subsidized_gateway_keys")
      .select("encrypted_key")
      .where("organization_id", "=", organizationId)
      .executeTakeFirst();
    if (!row) return null;
    return await this.vault.decrypt(row.encrypted_key);
  }

  /** Idempotent: a concurrent double-provision (the gateway returns the same
   *  key for the same org) resolves to one row. */
  async put(organizationId: string, apiKey: string): Promise<void> {
    const encrypted = await this.vault.encrypt(apiKey);
    await this.db
      .insertInto("subsidized_gateway_keys")
      .values({ organization_id: organizationId, encrypted_key: encrypted })
      .onConflict((oc) =>
        oc.column("organization_id").doUpdateSet({ encrypted_key: encrypted }),
      )
      .execute();
  }
}
