/**
 * Blog records over the real org filesystem — storage-integration tier (real
 * Postgres manifest + DevObjectStorage, zero mocks). What is under test is the
 * read-merge-write in `updateBlogRecord`, whose correctness lives in the
 * manifest's content hashes. See TESTING.md.
 */

import { rmSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { DevObjectStorage } from "../object-storage/dev-object-storage";
import { OrgFsEntryStorage } from "../storage/org-fs";
import { readBlogRecord, updateBlogRecord } from "./blog-state";
import { OrgFs, OrgFsConflictError, OrgFsNotFoundError } from "./org-fs";

const ORG = "org_blog_records";
const ACTOR = "user_blog_records";
const VOLUME = "home";
const PATH = "brands/acme/cards/aurora-1.json";
const ASSETS_DIR = `./data/assets/${ORG}`;

async function seedOrg(db: StudioDatabase) {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO "organization" (id, name, slug, "createdAt")
    VALUES (${ORG}, ${ORG}, ${ORG}, ${now})
    ON CONFLICT (id) DO NOTHING
  `.execute(db.db);
}

async function stored(fs: OrgFs): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await fs.read(VOLUME, PATH)));
}

describe("blog records (integration)", () => {
  let db: StudioDatabase;
  let fs: OrgFs;

  beforeAll(async () => {
    db = await connectTestPgDatabase();
  });

  afterAll(async () => {
    await closeTestPgDatabase(db);
  });

  beforeEach(async () => {
    await resetTestPgDatabase(db);
    await seedOrg(db);
    rmSync(ASSETS_DIR, { recursive: true, force: true });
    fs = new OrgFs(
      new DevObjectStorage(ORG, "http://test"),
      new OrgFsEntryStorage(db.db),
      ORG,
    );
    await fs.write(VOLUME, PATH, JSON.stringify({ a: 1 }), { actor: ACTOR });
  });

  it("reports the version the manifest holds", async () => {
    const read = await readBlogRecord(fs, PATH);
    const stat = await fs.stat(VOLUME, PATH);
    expect(read?.data).toEqual({ a: 1 });
    expect(read?.version).toBe(stat?.contentHash ?? "missing");
  });

  it("reads an absent record as null", async () => {
    expect(await readBlogRecord(fs, "brands/acme/cards/none.json")).toBeNull();
    await expect(
      updateBlogRecord(fs, ACTOR, "brands/acme/cards/none.json", (c) => c),
    ).rejects.toBeInstanceOf(OrgFsNotFoundError);
  });

  it("merges a write that landed between its read and its write", async () => {
    let interleaved = false;
    const { data } = await updateBlogRecord(
      fs,
      ACTOR,
      PATH,
      async (current) => {
        if (!interleaved) {
          interleaved = true;
          await updateBlogRecord(fs, ACTOR, PATH, (c) => ({ ...c, b: 2 }));
        }
        return { ...current, c: 3 };
      },
    );
    expect(data).toEqual({ a: 1, b: 2, c: 3 });
    expect(await stored(fs)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("gives up after three attempts with the conflict itself", async () => {
    let n = 0;
    await expect(
      updateBlogRecord(fs, ACTOR, PATH, async (current) => {
        n += 1;
        await updateBlogRecord(fs, ACTOR, PATH, (c) => ({
          ...c,
          [`w${n}`]: n,
        }));
        return { ...current, lost: true };
      }),
    ).rejects.toBeInstanceOf(OrgFsConflictError);
    expect(n).toBe(3);
    expect(await stored(fs)).toEqual({ a: 1, w1: 1, w2: 2, w3: 3 });
  });

  it("refuses a stale expected version, once", async () => {
    const read = await readBlogRecord(fs, PATH);
    await updateBlogRecord(fs, ACTOR, PATH, (c) => ({ ...c, b: 2 }));
    let attempts = 0;
    await expect(
      updateBlogRecord(
        fs,
        ACTOR,
        PATH,
        (c) => {
          attempts += 1;
          return { ...c, c: 3 };
        },
        { expect: read?.version },
      ),
    ).rejects.toBeInstanceOf(OrgFsConflictError);
    expect(attempts).toBe(0);
    expect(await stored(fs)).toEqual({ a: 1, b: 2 });
  });

  it("writes with the current expected version", async () => {
    const read = await readBlogRecord(fs, PATH);
    const { entry } = await updateBlogRecord(
      fs,
      ACTOR,
      PATH,
      (c) => ({ ...c, b: 2 }),
      { expect: read?.version },
    );
    expect(entry.contentHash).not.toBe(read?.version);
    expect(await stored(fs)).toEqual({ a: 1, b: 2 });
  });
});
