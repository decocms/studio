/**
 * Real-Postgres coverage for pruneUndecryptableJwks() — the local-mode
 * self-heal that recovers pre-fix installs whose JWKS was encrypted under a
 * now-lost random secret (see local-mode.ts / settings/local-secret.ts).
 *
 * These assert the exact wire/storage contract Better Auth uses: privateKey is
 * stored as a JSON-encoded hex ciphertext keyed by the auth secret, so the
 * probe must delete only rows that fail to decrypt under the current secret and
 * leave valid ones untouched.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { symmetricEncrypt } from "better-auth/crypto";
import { sql } from "kysely";
import { pruneUndecryptableJwks } from "./local-mode";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
} from "../database/test-db-pg";

const SECRET = "current-persisted-secret";
const OTHER_SECRET = "lost-per-process-secret";

/** Encode a private key the way Better Auth stores it: JSON-wrapped hex cipher. */
async function encodePrivateKey(secret: string, plaintext: string) {
  return JSON.stringify(
    await symmetricEncrypt({ key: secret, data: plaintext }),
  );
}

async function insertJwk(
  db: StudioDatabase["db"],
  id: string,
  privateKey: string,
) {
  await sql`
    insert into jwks (id, "publicKey", "privateKey", "createdAt")
    values (${id}, ${'{"pub":true}'}, ${privateKey}, now())
  `.execute(db);
}

async function jwkIds(db: StudioDatabase["db"]): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    select id from jwks order by id
  `.execute(db);
  return rows.map((r) => r.id);
}

describe("pruneUndecryptableJwks", () => {
  let database: StudioDatabase;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    // Self-contained: Better Auth owns this table via its own migrations, which
    // the Kysely-only test harness does not run.
    await sql`
      create table if not exists jwks (
        id text primary key,
        "publicKey" text not null,
        "privateKey" text not null,
        "createdAt" timestamptz not null default now()
      )
    `.execute(database.db);
  });

  afterAll(async () => {
    await sql`delete from jwks`.execute(database.db);
    await closeTestPgDatabase(database);
  });

  beforeEach(async () => {
    await sql`delete from jwks`.execute(database.db);
  });

  it("deletes keys that no longer decrypt and keeps the ones that do", async () => {
    await insertJwk(
      database.db,
      "good",
      await encodePrivateKey(SECRET, "k-good"),
    );
    await insertJwk(
      database.db,
      "wrong-secret",
      await encodePrivateKey(OTHER_SECRET, "k-stale"),
    );
    await insertJwk(database.db, "corrupt", "not-valid-json{");

    const removed = await pruneUndecryptableJwks(database.db, SECRET);

    expect(removed).toBe(2);
    expect(await jwkIds(database.db)).toEqual(["good"]);
  });

  it("is a no-op when every key decrypts (idempotent across restarts)", async () => {
    await insertJwk(database.db, "a", await encodePrivateKey(SECRET, "k-a"));
    await insertJwk(database.db, "b", await encodePrivateKey(SECRET, "k-b"));

    expect(await pruneUndecryptableJwks(database.db, SECRET)).toBe(0);
    // Second boot: still clean, still a no-op.
    expect(await pruneUndecryptableJwks(database.db, SECRET)).toBe(0);
    expect(await jwkIds(database.db)).toEqual(["a", "b"]);
  });

  it("removes every key when the secret rotated out from under all of them", async () => {
    await insertJwk(
      database.db,
      "x",
      await encodePrivateKey(OTHER_SECRET, "k-x"),
    );
    await insertJwk(
      database.db,
      "y",
      await encodePrivateKey(OTHER_SECRET, "k-y"),
    );

    expect(await pruneUndecryptableJwks(database.db, SECRET)).toBe(2);
    expect(await jwkIds(database.db)).toEqual([]);
  });
});
