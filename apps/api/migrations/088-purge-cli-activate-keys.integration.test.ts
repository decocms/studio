/**
 * Integration test for migration 083.
 *
 * Verifies that `up` deletes all rows where `provider_id` is `claude-code`
 * or `codex` (the sentinel rows created by the deprecated
 * `AI_PROVIDER_CLI_ACTIVATE` tool) and leaves all other rows untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { StudioDatabase } from "../src/database";
import { up as up088 } from "./088-purge-cli-activate-keys";

const ORG = "org_test";
const USER = "user_test";

async function insertProviderKey(
  database: StudioDatabase,
  id: string,
  providerId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO ai_provider_keys (
      id, organization_id, created_by, provider_id, label, encrypted_api_key, created_at
    ) VALUES (
      ${id}, ${ORG}, ${USER}, ${providerId}, 'cli-local', 'cli-local', ${now}
    )
  `.execute(database.db);
}

async function countByProvider(
  database: StudioDatabase,
  providerId: string,
): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM ai_provider_keys WHERE provider_id = ${providerId}
  `.execute(database.db);
  return result.rows[0]?.n ?? 0;
}

describe("migration 083 — purge cli-activate sentinel keys", () => {
  let database: StudioDatabase;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
  });

  afterEach(async () => {
    await closeTestPgDatabase(database);
  });

  it("removes claude-code and codex rows", async () => {
    await insertProviderKey(database, "apk_claude", "claude-code");
    await insertProviderKey(database, "apk_codex", "codex");

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up088(database.db as any);

    expect(await countByProvider(database, "claude-code")).toBe(0);
    expect(await countByProvider(database, "codex")).toBe(0);
  });

  it("leaves rows with other provider_ids untouched", async () => {
    await insertProviderKey(database, "apk_openai", "openai");
    await insertProviderKey(database, "apk_claude", "claude-code");

    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await up088(database.db as any);

    expect(await countByProvider(database, "openai")).toBe(1);
    expect(await countByProvider(database, "claude-code")).toBe(0);
  });

  it("is a no-op when no matching rows exist", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: migration accepts the test Kysely instance
    await expect(up088(database.db as any)).resolves.toBeUndefined();
  });
});
