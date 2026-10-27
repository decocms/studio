import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
} from "../database/test-db-pg";
import { CredentialVault } from "../encryption/credential-vault";
import { CodexSubscriptionStorage } from "./codex-subscriptions";

describe("Codex subscription storage", () => {
  let database: StudioDatabase;
  let storage: CodexSubscriptionStorage;
  const userId = `user_codex_${crypto.randomUUID()}`;
  const auth = JSON.stringify({
    tokens: {
      access_token: "access_example",
      refresh_token: "refresh_example",
      id_token: "id_example",
      account_id: "account_example",
    },
  });
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    const now = new Date().toISOString();
    await sql`INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt") VALUES (${userId}, ${`${userId}@example.com`}, false, 'Codex test', ${now}, ${now})`.execute(
      database.db,
    );
    storage = new CodexSubscriptionStorage(
      database.db,
      new CredentialVault(CredentialVault.generateKey()),
    );
  });

  afterAll(async () => {
    if (database) {
      await database.db.deleteFrom("user").where("id", "=", userId).execute();
      await closeTestPgDatabase(database);
    }
  });

  test("encrypts persisted bytes, scopes reads, and prevents stale refreshes after relinking or disconnecting", async () => {
    await storage.upsert(userId, auth);
    const row = await database.db
      .selectFrom("codex_subscriptions")
      .selectAll()
      .where("user_id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(row.encrypted_auth).not.toContain("access_example");
    expect(row.encrypted_auth).not.toContain("refresh_example");
    expect(await storage.findLiveToken(userId)).toBe(auth);
    expect(await storage.findLiveToken("user_missing_example")).toBeNull();
    expect(JSON.stringify(await storage.find(userId))).not.toContain("tokens");
    const refreshed = auth.replace("access_example", "access_refreshed");
    expect(await storage.sync(userId, digest(auth), refreshed)).toBeTrue();
    expect(await storage.sync(userId, digest(auth), auth)).toBeFalse();
    await storage.upsert(userId, auth);
    expect(
      await storage.sync(userId, digest(refreshed), refreshed),
    ).toBeFalse();
    await storage.delete(userId);
    expect(await storage.sync(userId, digest(auth), refreshed)).toBeFalse();
    expect(await storage.find(userId)).toBeNull();
  });

  test("deletes credentials with their user", async () => {
    await storage.upsert(userId, auth);
    await database.db.deleteFrom("user").where("id", "=", userId).execute();
    expect(await storage.find(userId)).toBeNull();
  });
});
