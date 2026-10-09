import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql, type Kysely } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { StudioDatabase } from "../src/database";
import { up } from "./235-prune-empty-thread-dirs";

let database: StudioDatabase;
beforeAll(async () => {
  database = await connectTestPgDatabase();
  await seedCommonTestPgFixtures(database);
});
afterAll(async () => {
  await closeTestPgDatabase(database);
});

const EMPTY = "0b6c3f5e-6f1d-4c2a-9d3e-1a2b3c4d5e6f";
const FULL = "1c7d4a6f-7a2e-4d3b-8e4f-2b3c4d5e6f70";
const FRESH = "2d8e5b70-8b3f-4e4c-9f50-3c4d5e6f7081";

test("tombstones old empty thread folders in chat volumes, and nothing else", async () => {
  const transaction = await database.db.startTransaction().execute();
  try {
    const old = sql`now() - interval '2 days'`;
    await sql`INSERT INTO org_fs_entry (organization_id, volume, path, parent, kind, created_by, updated_by, created_at)
      VALUES
      ('org_1', 'outputs', ${EMPTY}, '', 'dir', 'u', 'u', ${old}),
      ('org_1', 'outputs', ${FULL}, '', 'dir', 'u', 'u', ${old}),
      ('org_1', 'outputs', ${`${FULL}/a.md`}, ${FULL}, 'file', 'u', 'u', ${old}),
      ('org_1', 'uploads', ${FRESH}, '', 'dir', 'u', 'u', now()),
      ('org_1', 'uploads', ${EMPTY}, '', 'dir', 'u', 'u', ${old}),
      ('org_1', 'home', ${EMPTY}, '', 'dir', 'u', 'u', ${old}),
      ('org_1', 'outputs', 'Reports', '', 'dir', 'u', 'u', ${old})
    `.execute(transaction);

    const migrationDb = transaction as unknown as Kysely<unknown>;
    await up(migrationDb);
    await up(migrationDb);

    const live = await transaction
      .selectFrom("org_fs_entry")
      .select(["volume", "path"])
      .where("organization_id", "=", "org_1")
      .where("deleted_at", "is", null)
      .execute();
    expect(live.map((r) => `${r.volume}:${r.path}`).sort()).toEqual(
      [
        `home:${EMPTY}`,
        `outputs:${FULL}`,
        `outputs:${FULL}/a.md`,
        "outputs:Reports",
        `uploads:${FRESH}`,
      ].sort(),
    );
  } finally {
    await transaction.rollback().execute();
  }
});
