import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "kysely";
import {
  connectTestPgDatabase,
  closeTestPgDatabase,
} from "../src/database/test-db-pg";
import type { StudioDatabase } from "../src/database";
import { down, up } from "./206-repository-consumers";

let database: StudioDatabase;
beforeAll(async () => {
  database = await connectTestPgDatabase();
});
afterAll(async () => {
  await closeTestPgDatabase(database);
});

test("backfills legacy repositories and keeps later legacy writers coherent without replacing account credentials", async () => {
  await database.db.transaction().execute(async (trx) => {
    await down(trx);
    const suffix = crypto.randomUUID();
    const user = `user-${suffix}`;
    const org = `org-${suffix}`;
    await sql`INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt") VALUES (${user}, ${`${suffix}@example.test`}, true, 'Example', now(), now())`.execute(
      trx,
    );
    await sql`INSERT INTO organization (id, name, slug, "createdAt") VALUES (${org}, 'Example', ${org}, now())`.execute(
      trx,
    );
    const metadata = JSON.stringify({
      repoScope: { owner: "example", repo: "project", installationId: 123 },
    });
    const createConnection = (id: string, value: string) =>
      sql`
      INSERT INTO connections (id, organization_id, title, connection_type, connection_url, slug, metadata, status, pinned, created_by, updated_by, created_at, updated_at)
      VALUES (${id}, ${org}, 'Example repo', 'HTTP', 'https://example.test/mcp', 'mcp-github', ${value}, 'active', false, ${user}, ${user}, now(), now())
    `.execute(trx);
    const first = `conn-first-${suffix}`;
    await createConnection(first, metadata);
    await createConnection(`conn-malformed-${suffix}`, "{invalid");
    await up(trx);
    const repositories = () =>
      trx
        .selectFrom("repositories")
        .selectAll()
        .where("organization_id", "=", org)
        .execute();
    const initial = await repositories();
    expect(initial).toHaveLength(1);
    expect(initial[0]?.legacy_connection_id).toBe(first);
    expect(initial[0]?.account_id).not.toBeNull();
    const account = initial[0]!.account_id!;
    await trx
      .updateTable("git_provider_accounts")
      .set({ login: "Connected account", credential_connection_id: null })
      .where("id", "=", account)
      .execute();
    await createConnection(`conn-second-${suffix}`, metadata);
    expect(await repositories()).toHaveLength(1);
    const unchanged = await trx
      .selectFrom("git_provider_accounts")
      .selectAll()
      .where("id", "=", account)
      .executeTakeFirstOrThrow();
    expect(unchanged.login).toBe("Connected account");
    expect(unchanged.credential_connection_id).toBeNull();
    await createConnection(
      `conn-third-${suffix}`,
      JSON.stringify({
        repoScope: { owner: "example", repo: "second", installationId: 123 },
      }),
    );
    expect(await repositories()).toHaveLength(2);
    await trx
      .deleteFrom("git_provider_accounts")
      .where("id", "=", account)
      .execute();
    await sql`UPDATE connections SET metadata = ${metadata} WHERE id = ${first}`.execute(
      trx,
    );
    const disconnected = await trx
      .selectFrom("git_provider_accounts")
      .select("id")
      .where("organization_id", "=", org)
      .execute();
    expect(disconnected).toEqual([]);
  });
}, 30000);
