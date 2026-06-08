/**
 * OrgFs service — storage-integration tier (real Postgres + real object
 * storage, zero mocks). Exercises the path/tree layer over the manifest +
 * DevObjectStorage end to end. See TESTING.md.
 *
 * Local run:
 *   docker run -d --name pg -p 5432:5432 -e POSTGRES_USER=postgres \
 *     -e POSTGRES_PASSWORD=postgres postgres:16
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
 *     bun run --cwd=apps/mesh migrate
 *   DATABASE_URL=... bun test apps/mesh/src/file-storage/org-fs.integration.test.ts
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
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { createBoundObjectStorage } from "../object-storage/bound-object-storage";
import { DevObjectStorage } from "../object-storage/dev-object-storage";
import { S3Service } from "../object-storage/s3-service";
import { OrgFsEntryStorage } from "../storage/org-fs";
import { OrgFs, OrgFsQuotaError, OrgFsValidationError } from "./org-fs";

const ORG = "org_fs_svc";
const ACTOR = "user_fs_svc";
const ASSETS_DIR = `./data/assets/${ORG}`;

function buildFs(db: StudioDatabase, limits = {}) {
  const storage = new DevObjectStorage(ORG, "http://test");
  const manifest = new OrgFsEntryStorage(db.db);
  return new OrgFs(storage, manifest, ORG, limits);
}

async function seedOrg(db: StudioDatabase) {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO "organization" (id, name, slug, "createdAt")
    VALUES (${ORG}, ${ORG}, ${ORG}, ${now})
    ON CONFLICT (id) DO NOTHING
  `.execute(db.db);
}

describe("OrgFs service (integration)", () => {
  let db: StudioDatabase;
  let fs: OrgFs;

  beforeAll(async () => {
    db = await connectTestPgDatabase();
  });

  beforeEach(async () => {
    await resetTestPgDatabase(db);
    await seedOrg(db);
    rmSync(ASSETS_DIR, { recursive: true, force: true });
    fs = buildFs(db);
  });

  it("writes a file and reads identical bytes back", async () => {
    const entry = await fs.write("skills", "hello.txt", "hi there", {
      actor: ACTOR,
    });
    expect(entry.kind).toBe("file");
    expect(entry.path).toBe("hello.txt");
    expect(entry.parent).toBe("");
    expect(entry.size).toBe(8);
    expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const bytes = await fs.read("skills", "hello.txt");
    expect(new TextDecoder().decode(bytes)).toBe("hi there");

    const stat = await fs.stat("skills", "hello.txt");
    expect(stat?.contentHash).toBe(entry.contentHash);
  });

  it("creates ancestor directories on nested write and lists the tree", async () => {
    await fs.write("skills", "a/b/c.txt", "deep", { actor: ACTOR });

    const root = await fs.listDir("skills", "");
    expect(root.map((e) => e.path)).toEqual(["a"]);
    expect(root[0]!.kind).toBe("dir");

    const a = await fs.listDir("skills", "a");
    expect(a.map((e) => e.path)).toEqual(["a/b"]);

    const ab = await fs.listDir("skills", "a/b");
    expect(ab.map((e) => e.path)).toEqual(["a/b/c.txt"]);
    expect(ab[0]!.kind).toBe("file");
  });

  it("mkdir is idempotent and does not bump the change feed twice", async () => {
    await fs.mkdir("skills", "docs", { actor: ACTOR });
    const first = await fs.changes("skills", "0");
    await fs.mkdir("skills", "docs", { actor: ACTOR });
    const second = await fs.changes("skills", "0");
    expect(first.entries.length).toBe(1);
    expect(second.entries.length).toBe(1); // no new seq for an existing dir
    expect((await fs.listDir("skills", ""))[0]!.path).toBe("docs");
  });

  it("deletes a file (tombstone + bytes gone)", async () => {
    await fs.write("skills", "x.txt", "bye", { actor: ACTOR });
    await fs.delete("skills", "x.txt", { actor: ACTOR });
    expect(await fs.stat("skills", "x.txt")).toBeNull();
    expect(fs.read("skills", "x.txt")).rejects.toThrow();
  });

  it("deletes a directory recursively", async () => {
    await fs.write("skills", "d/one.txt", "1", { actor: ACTOR });
    await fs.write("skills", "d/sub/two.txt", "2", { actor: ACTOR });
    await fs.delete("skills", "d", { actor: ACTOR });
    expect(await fs.stat("skills", "d")).toBeNull();
    expect(await fs.stat("skills", "d/one.txt")).toBeNull();
    expect(await fs.stat("skills", "d/sub/two.txt")).toBeNull();
    expect(await fs.listDir("skills", "")).toEqual([]);
  });

  it("moves a file, preserving bytes", async () => {
    await fs.write("skills", "from.txt", "payload", { actor: ACTOR });
    await fs.move("skills", "from.txt", "nested/to.txt", { actor: ACTOR });
    expect(await fs.stat("skills", "from.txt")).toBeNull();
    const moved = await fs.read("skills", "nested/to.txt");
    expect(new TextDecoder().decode(moved)).toBe("payload");
  });

  it("moves a directory recursively", async () => {
    await fs.write("skills", "src/a.txt", "A", { actor: ACTOR });
    await fs.write("skills", "src/deep/b.txt", "B", { actor: ACTOR });
    await fs.move("skills", "src", "dst", { actor: ACTOR });
    expect(await fs.stat("skills", "src/a.txt")).toBeNull();
    expect(new TextDecoder().decode(await fs.read("skills", "dst/a.txt"))).toBe(
      "A",
    );
    expect(
      new TextDecoder().decode(await fs.read("skills", "dst/deep/b.txt")),
    ).toBe("B");
  });

  it("rejects moving a path onto itself or into its own subtree (no data loss)", async () => {
    await fs.write("skills", "keep.txt", "precious", { actor: ACTOR });
    expect(
      fs.move("skills", "keep.txt", "keep.txt", { actor: ACTOR }),
    ).rejects.toBeInstanceOf(OrgFsValidationError);
    // The source must still be intact after the rejected self-move.
    expect(new TextDecoder().decode(await fs.read("skills", "keep.txt"))).toBe(
      "precious",
    );

    await fs.write("skills", "dir/a.txt", "a", { actor: ACTOR });
    expect(
      fs.move("skills", "dir", "dir/sub", { actor: ACTOR }),
    ).rejects.toBeInstanceOf(OrgFsValidationError);
    expect(await fs.stat("skills", "dir/a.txt")).not.toBeNull();
  });

  it("rejects writing a file where a directory exists", async () => {
    await fs.write("skills", "docs/readme.md", "hi", { actor: ACTOR });
    // "docs" is a directory now.
    expect(
      fs.write("skills", "docs", "oops", { actor: ACTOR }),
    ).rejects.toBeInstanceOf(OrgFsValidationError);
    // The directory and its child survive.
    expect((await fs.stat("skills", "docs"))?.kind).toBe("dir");
    expect(await fs.stat("skills", "docs/readme.md")).not.toBeNull();
  });

  it("rejects mkdir where a file exists", async () => {
    await fs.write("skills", "notes", "i am a file", { actor: ACTOR });
    expect(
      fs.mkdir("skills", "notes", { actor: ACTOR }),
    ).rejects.toBeInstanceOf(OrgFsValidationError);
    expect((await fs.stat("skills", "notes"))?.kind).toBe("file");
  });

  it("signals hasMore when a full page is returned", async () => {
    await fs.write("skills", "a.txt", "1", { actor: ACTOR });
    await fs.write("skills", "b.txt", "2", { actor: ACTOR });
    const page = await fs.changes("skills", "0", 1);
    expect(page.entries.length).toBe(1);
    expect(page.hasMore).toBe(true);
    const rest = await fs.changes("skills", page.cursor, 50);
    expect(rest.hasMore).toBe(false);
  });

  it("emits an ordered, cursor-advancing change feed including tombstones", async () => {
    await fs.write("skills", "f1.txt", "1", { actor: ACTOR });
    await fs.write("skills", "f2.txt", "2", { actor: ACTOR });

    const first = await fs.changes("skills", "0");
    const paths = first.entries.map((e) => e.path);
    expect(paths).toContain("f1.txt");
    expect(paths).toContain("f2.txt");
    // strictly increasing seq
    const seqs = first.entries.map((e) => BigInt(e.seq));
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]! > seqs[i - 1]!).toBe(true);
    }

    // Nothing new since the cursor.
    const idle = await fs.changes("skills", first.cursor);
    expect(idle.entries).toEqual([]);
    expect(idle.cursor).toBe(first.cursor);

    // A delete shows up as a tombstone past the cursor.
    await fs.delete("skills", "f1.txt", { actor: ACTOR });
    const after = await fs.changes("skills", first.cursor);
    expect(after.entries.length).toBe(1);
    expect(after.entries[0]!.path).toBe("f1.txt");
    expect(after.entries[0]!.deletedAt).not.toBeNull();
  });

  it("reports usage and excludes deleted files; overwrite does not double-count", async () => {
    await fs.write("skills", "a.txt", "12345", { actor: ACTOR }); // 5
    await fs.write("skills", "b.txt", "678", { actor: ACTOR }); // 3
    let usage = await fs.usage("skills");
    expect(usage).toEqual({ files: 2, bytes: 8 });

    // Overwrite a.txt larger — count must reflect the new size, not the sum.
    await fs.write("skills", "a.txt", "1234567890", { actor: ACTOR }); // 10
    usage = await fs.usage("skills");
    expect(usage).toEqual({ files: 2, bytes: 13 });

    await fs.delete("skills", "b.txt", { actor: ACTOR });
    usage = await fs.usage("skills");
    expect(usage).toEqual({ files: 1, bytes: 10 });
  });

  it("isolates volumes from each other", async () => {
    await fs.write("skills", "s.txt", "s", { actor: ACTOR });
    await fs.write("things", "t.txt", "tt", { actor: ACTOR });
    expect((await fs.listDir("skills", "")).map((e) => e.path)).toEqual([
      "s.txt",
    ]);
    expect((await fs.listDir("things", "")).map((e) => e.path)).toEqual([
      "t.txt",
    ]);
    expect(await fs.usage("skills")).toEqual({ files: 1, bytes: 1 });
    expect(await fs.usage("things")).toEqual({ files: 1, bytes: 2 });
  });

  it("rejects writing to the volume root", async () => {
    expect(
      fs.write("skills", "", "x", { actor: ACTOR }),
    ).rejects.toBeInstanceOf(OrgFsValidationError);
  });

  it("enforces the per-file byte limit", async () => {
    const tiny = buildFs(db, { maxFileBytes: 4 });
    expect(
      tiny.write("skills", "big.txt", "12345", { actor: ACTOR }),
    ).rejects.toBeInstanceOf(OrgFsQuotaError);
    // At/under the limit succeeds.
    const ok = await tiny.write("skills", "ok.txt", "1234", { actor: ACTOR });
    expect(ok.size).toBe(4);
  });

  it("enforces the per-volume quota", async () => {
    const small = buildFs(db, { volumeQuotaBytes: 10 });
    await small.write("skills", "a.txt", "1234567", { actor: ACTOR }); // 7
    expect(
      small.write("skills", "b.txt", "5678", { actor: ACTOR }), // 7+4 = 11 > 10
    ).rejects.toBeInstanceOf(OrgFsQuotaError);
    // Overwriting in place within quota is allowed (no double-count).
    const ok = await small.write("skills", "a.txt", "999", { actor: ACTOR });
    expect(ok.size).toBe(3);
  });

  // backfillFromStorage relies on recursive prefix listing (S3 semantics), so
  // it must run against a real S3 backend (MinIO), NOT DevObjectStorage whose
  // list() is single-directory only. CI's storage-integration job provides
  // MinIO via S3_ENDPOINT/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY.
  it("backfills the manifest from pre-existing objects (recursive, S3)", async () => {
    const endpoint = process.env.S3_ENDPOINT ?? "http://localhost:9000";
    const bucket = "org-fs-integration";
    const client = new S3Client({
      endpoint,
      region: "us-east-1",
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
      },
      forcePathStyle: true,
    });
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch {
      // Bucket may already exist from a previous run.
    }

    const s3 = new S3Service({
      endpoint,
      bucket,
      region: "us-east-1",
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
      forcePathStyle: true,
    });
    const s3Storage = createBoundObjectStorage(s3, ORG);
    const s3Fs = new OrgFs(s3Storage, new OrgFsEntryStorage(db.db), ORG);

    // Unique volume so prior runs' objects (MinIO isn't reset) don't bleed in.
    const volume = `bf${crypto.randomUUID().replace(/-/g, "")}`;
    await s3Storage.put(`_fs/${volume}/top.md`, "top");
    await s3Storage.put(`_fs/${volume}/nested/one.md`, "one");
    await s3Storage.put(`_fs/${volume}/nested/deep/two.md`, "two");

    const count = await s3Fs.backfillFromStorage(volume, { actor: ACTOR });
    expect(count).toBe(3);

    // Nested entries were recursively seeded AND ancestor dirs created.
    expect((await s3Fs.listDir(volume, "")).map((e) => e.path).sort()).toEqual([
      `nested`,
      `top.md`,
    ]);
    expect(
      (await s3Fs.listDir(volume, "nested")).map((e) => e.path).sort(),
    ).toEqual(["nested/deep", "nested/one.md"]);
    expect(
      new TextDecoder().decode(await s3Fs.read(volume, "nested/deep/two.md")),
    ).toBe("two");
  });

  afterAll(async () => {
    rmSync(ASSETS_DIR, { recursive: true, force: true });
    if (db) await closeTestPgDatabase(db);
  });
});
