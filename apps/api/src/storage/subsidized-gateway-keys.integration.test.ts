import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { CredentialVault } from "../encryption/credential-vault";
import { SubsidizedGatewayKeyStorage } from "./subsidized-gateway-keys";

// Real-Postgres coverage for the subsidy-key store: it holds a live gateway
// credential, so the encrypt/decrypt roundtrip and the re-provision
// overwrite are load-bearing.
const ORG = "org_subsidy_1";

describe("SubsidizedGatewayKeyStorage", () => {
  let database: StudioDatabase;
  let storage: SubsidizedGatewayKeyStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await database.db
      .insertInto("organization")
      .values({
        id: ORG,
        name: ORG,
        slug: "org-subsidy-1",
        createdAt: new Date().toISOString(),
      })
      .execute();
    storage = new SubsidizedGatewayKeyStorage(
      database.db,
      new CredentialVault(CredentialVault.generateKey()),
    );
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("roundtrips the key through the vault and never stores it in clear", async () => {
    await storage.put(ORG, "sk-subsidy-abc");
    expect(await storage.get(ORG)).toBe("sk-subsidy-abc");

    const row = await database.db
      .selectFrom("subsidized_gateway_keys")
      .select("encrypted_key")
      .where("organization_id", "=", ORG)
      .executeTakeFirstOrThrow();
    expect(row.encrypted_key).not.toContain("sk-subsidy-abc");
  });

  it("re-provisioning overwrites in place (one row per org)", async () => {
    await storage.put(ORG, "sk-subsidy-rotated");
    expect(await storage.get(ORG)).toBe("sk-subsidy-rotated");
    const rows = await database.db
      .selectFrom("subsidized_gateway_keys")
      .select("organization_id")
      .where("organization_id", "=", ORG)
      .execute();
    expect(rows.length).toBe(1);
  });

  it("an org with no key resolves to null (caller provisions)", async () => {
    expect(await storage.get("org_without_key")).toBeNull();
  });
});
