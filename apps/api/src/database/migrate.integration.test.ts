import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "./index";
import { runKyselyMigrations } from "./migrate";
import { closeTestPgDatabase, connectTestPgDatabase } from "./test-db-pg";

const NEWER = "999999-from-a-newer-release";

let database: StudioDatabase;
beforeAll(async () => {
  database = await connectTestPgDatabase();
});
afterAll(async () => {
  await sql`DELETE FROM kysely_migration WHERE name = ${NEWER}`.execute(
    database.db,
  );
  await closeTestPgDatabase(database);
});

test("boots after a rollback to a build that predates an applied migration", async () => {
  await sql`INSERT INTO kysely_migration (name, timestamp) VALUES (${NEWER}, now()::text)`.execute(
    database.db,
  );

  expect(await runKyselyMigrations(database.db)).toBe(0);
});
