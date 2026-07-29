/**
 * OrgFs service — storage-integration tier (real Postgres + real object
 * storage, zero mocks). Exercises the path/tree layer over the manifest +
 * DevObjectStorage end to end. See TESTING.md.
 *
 * Local run:
 *   docker run -d --name pg -p 5432:5432 -e POSTGRES_USER=postgres \
 *     -e POSTGRES_PASSWORD=postgres postgres:16
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
 *     bun run --cwd=apps/api migrate
 *   DATABASE_URL=... bun test apps/api/src/file-storage/org-fs.integration.test.ts
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
import { verifySharePassword } from "./share-password";

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

  it("recent() lists live files across volumes, newest first, no dirs/tombstones", async () => {
    await fs.write("skills", "old.txt", "1", { actor: ACTOR });
    await fs.mkdir("skills", "docs", { actor: ACTOR });
    await fs.write("outputs", "thread-1/report.pdf", "2", { actor: ACTOR });
    await fs.write("skills", "gone.txt", "3", { actor: ACTOR });
    await fs.delete("skills", "gone.txt", { actor: ACTOR });
    await fs.write("skills", "newest.md", "4", { actor: ACTOR });

    const recent = await fs.recent(10);
    expect(recent.map((e) => [e.volume, e.path])).toEqual([
      ["skills", "newest.md"],
      ["outputs", "thread-1/report.pdf"],
      ["skills", "old.txt"],
    ]);

    // Re-writing an old file bumps it to the front; limit caps the page.
    await fs.write("skills", "old.txt", "updated", { actor: ACTOR });
    const capped = await fs.recent(2);
    expect(capped.map((e) => e.path)).toEqual(["old.txt", "newest.md"]);
  });

  it("searchWithEffectivePublic matches path substrings, escapes LIKE metacharacters, resolves inherited public", async () => {
    await fs.write("skills", "reports/Q1-Sales.md", "1", { actor: ACTOR });
    await fs.write("outputs", "thread-1/sales_deck.html", "2", {
      actor: ACTOR,
    });
    await fs.write("skills", "notes.txt", "3", { actor: ACTOR });
    await fs.write("skills", "gone-sales.txt", "x", { actor: ACTOR });
    await fs.delete("skills", "gone-sales.txt", { actor: ACTOR });
    await fs.setReadPublic("skills", "reports", true, { actor: ACTOR });

    // Case-insensitive, newest first, no tombstones; folder publish inherits.
    const hits = await fs.searchWithEffectivePublic("sales", 10);
    expect(hits.map((e) => [e.volume, e.path, e.effectivePublic])).toEqual([
      ["outputs", "thread-1/sales_deck.html", false],
      ["skills", "reports/Q1-Sales.md", true],
    ]);

    // `_` is a literal, not a single-char wildcard ("Sales." must not match).
    expect(
      (await fs.searchWithEffectivePublic("sales_", 10)).map((e) => e.path),
    ).toEqual(["thread-1/sales_deck.html"]);
    expect(await fs.searchWithEffectivePublic("%", 10)).toEqual([]);

    // Volume narrowing (the public-sets pseudo-org passes its set volumes).
    expect(
      (await fs.searchWithEffectivePublic("sales", 10, ["outputs"])).map(
        (e) => e.path,
      ),
    ).toEqual(["thread-1/sales_deck.html"]);
    expect(await fs.searchWithEffectivePublic("sales", 10, [])).toEqual([]);
  });

  it("searchWithEffectivePublic narrows to a directory subtree", async () => {
    await fs.write("skills", "reports/Q1-Sales.md", "1", { actor: ACTOR });
    await fs.write("skills", "reports/deep/Q2-Sales.md", "2", { actor: ACTOR });
    await fs.write("skills", "reports-archive/Q0-Sales.md", "3", {
      actor: ACTOR,
    });
    await fs.write("skills", "sales-loose.md", "4", { actor: ACTOR });

    // Recursive under the dir; siblings and same-prefix dir names excluded.
    expect(
      (await fs.searchWithEffectivePublic("sales", 10, undefined, "reports"))
        .map((e) => e.path)
        .toSorted(),
    ).toEqual(["reports/Q1-Sales.md", "reports/deep/Q2-Sales.md"]);

    // A prefix must be a whole path segment, and LIKE metacharacters are literal.
    expect(
      await fs.searchWithEffectivePublic("sales", 10, undefined, "report"),
    ).toEqual([]);
    expect(
      await fs.searchWithEffectivePublic("sales", 10, undefined, "_"),
    ).toEqual([]);

    // Prefix composes with volume narrowing.
    expect(
      await fs.searchWithEffectivePublic("sales", 10, ["outputs"], "reports"),
    ).toEqual([]);
  });

  it("filesExist batch-probes live files only", async () => {
    await fs.write("skills", "seo/SKILL.md", "skill", { actor: ACTOR });
    await fs.mkdir("skills", "plain", { actor: ACTOR });
    await fs.write("skills", "gone/SKILL.md", "x", { actor: ACTOR });
    await fs.delete("skills", "gone/SKILL.md", { actor: ACTOR });

    const found = await fs.filesExist("skills", [
      "seo/SKILL.md",
      "plain/SKILL.md",
      "gone/SKILL.md",
    ]);
    expect(found.has("seo/SKILL.md")).toBe(true);
    expect(found.has("plain/SKILL.md")).toBe(false);
    expect(found.has("gone/SKILL.md")).toBe(false);
    expect(await fs.filesExist("skills", [])).toEqual(new Set());
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

  it("preserves empty subdirectories when moving a directory", async () => {
    await fs.write("skills", "src/a.txt", "A", { actor: ACTOR });
    await fs.mkdir("skills", "src/empty", { actor: ACTOR });
    await fs.mkdir("skills", "src/empty/deeper", { actor: ACTOR });
    await fs.move("skills", "src", "dst", { actor: ACTOR });
    // The file moved...
    expect(new TextDecoder().decode(await fs.read("skills", "dst/a.txt"))).toBe(
      "A",
    );
    // ...and the empty subdirs (no descendant files) survive the move.
    expect((await fs.stat("skills", "dst/empty"))?.kind).toBe("dir");
    expect((await fs.stat("skills", "dst/empty/deeper"))?.kind).toBe("dir");
    expect(await fs.stat("skills", "src/empty")).toBeNull();
  });

  it("allows a same-volume rename even when the volume is near quota", async () => {
    // A rename's net size delta is ≤0, so it must not trip the volume quota
    // just because the source still counts until the trailing delete.
    const small = buildFs(db, { volumeQuotaBytes: 10 });
    await small.write("skills", "big.txt", "1234567", { actor: ACTOR }); // 7/10
    // Renaming the 7-byte file would momentarily "need" 14 bytes if the source
    // were double-counted; the move-copy leg must skip the volume-quota check.
    await small.move("skills", "big.txt", "renamed.txt", { actor: ACTOR });
    expect(await small.stat("skills", "big.txt")).toBeNull();
    expect(
      new TextDecoder().decode(await small.read("skills", "renamed.txt")),
    ).toBe("1234567");
    expect(await small.usage("skills")).toEqual({ files: 1, bytes: 7 });
  });

  it("rejects a non-numeric changes cursor with a validation error", async () => {
    expect(fs.changes("skills", "not-a-number")).rejects.toBeInstanceOf(
      OrgFsValidationError,
    );
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

  // --- Public sharing (read_public + inheritance) ------------------------

  it("publishes a file and reverts it; only a public file is publicly readable", async () => {
    await fs.write("home", "deck.html", "<h1>hi</h1>", { actor: ACTOR });
    expect(await fs.isPubliclyReadable("home", "deck.html")).toBe(false);

    const pub = await fs.setReadPublic("home", "deck.html", true, {
      actor: ACTOR,
    });
    expect(pub.readPublic).toBe(true);
    expect(await fs.isPubliclyReadable("home", "deck.html")).toBe(true);

    await fs.setReadPublic("home", "deck.html", false, { actor: ACTOR });
    expect(await fs.isPubliclyReadable("home", "deck.html")).toBe(false);
  });

  it("in-place overwrite preserves the public flag", async () => {
    await fs.write("home", "deck.html", "v1", { actor: ACTOR });
    await fs.setReadPublic("home", "deck.html", true, { actor: ACTOR });
    await fs.write("home", "deck.html", "v2", { actor: ACTOR });
    expect(await fs.isPubliclyReadable("home", "deck.html")).toBe(true);
  });

  it("delete + recreate resets a file to private (fails closed)", async () => {
    await fs.write("home", "deck.html", "v1", { actor: ACTOR });
    await fs.setReadPublic("home", "deck.html", true, { actor: ACTOR });
    await fs.delete("home", "deck.html", { actor: ACTOR });
    // Regenerating at the same path must NOT revive the published flag.
    await fs.write("home", "deck.html", "v2", { actor: ACTOR });
    expect((await fs.stat("home", "deck.html"))?.readPublic).toBe(false);
    expect(await fs.isPubliclyReadable("home", "deck.html")).toBe(false);
  });

  it("publishing a folder makes its whole subtree publicly readable", async () => {
    await fs.write("home", "site/index.html", "page", { actor: ACTOR });
    await fs.write("home", "site/assets/logo.png", "img", { actor: ACTOR });
    expect(await fs.isPubliclyReadable("home", "site/assets/logo.png")).toBe(
      false,
    );

    await fs.setReadPublic("home", "site", true, { actor: ACTOR });
    expect(await fs.isPubliclyReadable("home", "site/index.html")).toBe(true);
    expect(await fs.isPubliclyReadable("home", "site/assets/logo.png")).toBe(
      true,
    );
    // A file added AFTER publishing the folder inherits too.
    await fs.write("home", "site/assets/new.png", "img2", { actor: ACTOR });
    expect(await fs.isPubliclyReadable("home", "site/assets/new.png")).toBe(
      true,
    );

    await fs.setReadPublic("home", "site", false, { actor: ACTOR });
    expect(await fs.isPubliclyReadable("home", "site/index.html")).toBe(false);
  });

  it("delete + recreate resets a folder to private", async () => {
    await fs.write("home", "site/index.html", "page", { actor: ACTOR });
    await fs.setReadPublic("home", "site", true, { actor: ACTOR });
    await fs.delete("home", "site", { actor: ACTOR });
    await fs.write("home", "site/index.html", "page2", { actor: ACTOR });
    expect((await fs.stat("home", "site"))?.readPublic).toBe(false);
    expect(await fs.isPubliclyReadable("home", "site/index.html")).toBe(false);
  });

  // --- Password sharing ---------------------------------------------------

  it("password mode gates a file with a verifiable hash + secret", async () => {
    await fs.write("home", "secret.pdf", "data", { actor: ACTOR });
    await fs.setShareMode("home", "secret.pdf", "password", {
      actor: ACTOR,
      password: "hunter2",
    });
    expect((await fs.stat("home", "secret.pdf"))?.shareMode).toBe("password");
    const access = await fs.resolveReadAccess("home", "secret.pdf");
    expect(access.access).toBe("password");
    if (access.access === "password") {
      expect(access.govPath).toBe("secret.pdf");
      expect(access.secret.length).toBeGreaterThan(0);
      expect(await verifySharePassword("hunter2", access.passwordHash)).toBe(
        true,
      );
      expect(await verifySharePassword("nope", access.passwordHash)).toBe(
        false,
      );
    }
  });

  it("password mode requires a password", async () => {
    await fs.write("home", "x.txt", "y", { actor: ACTOR });
    expect(
      fs.setShareMode("home", "x.txt", "password", { actor: ACTOR }),
    ).rejects.toThrow();
  });

  it("resolveReadAccess: private / public / back to private", async () => {
    await fs.write("home", "a.txt", "1", { actor: ACTOR });
    expect((await fs.resolveReadAccess("home", "a.txt")).access).toBe(
      "private",
    );
    await fs.setShareMode("home", "a.txt", "public", { actor: ACTOR });
    expect((await fs.resolveReadAccess("home", "a.txt")).access).toBe("public");
    await fs.setShareMode("home", "a.txt", "private", { actor: ACTOR });
    expect((await fs.resolveReadAccess("home", "a.txt")).access).toBe(
      "private",
    );
  });

  it("a password folder gates its whole subtree (inherited govern node)", async () => {
    await fs.write("home", "vault/doc.pdf", "x", { actor: ACTOR });
    await fs.setShareMode("home", "vault", "password", {
      actor: ACTOR,
      password: "pw",
    });
    const access = await fs.resolveReadAccess("home", "vault/doc.pdf");
    expect(access.access).toBe("password");
    if (access.access === "password") {
      expect(access.govPath).toBe("vault");
      expect(await verifySharePassword("pw", access.passwordHash)).toBe(true);
    }
  });

  it("most-specific wins: a public file inside a password folder is public", async () => {
    await fs.write("home", "vault/open.txt", "x", { actor: ACTOR });
    await fs.setShareMode("home", "vault", "password", {
      actor: ACTOR,
      password: "pw",
    });
    await fs.setShareMode("home", "vault/open.txt", "public", { actor: ACTOR });
    expect((await fs.resolveReadAccess("home", "vault/open.txt")).access).toBe(
      "public",
    );
  });

  it("changing the password rotates the node secret (invalidates old cookies)", async () => {
    await fs.write("home", "s.txt", "x", { actor: ACTOR });
    await fs.setShareMode("home", "s.txt", "password", {
      actor: ACTOR,
      password: "one",
    });
    const a1 = await fs.resolveReadAccess("home", "s.txt");
    await fs.setShareMode("home", "s.txt", "password", {
      actor: ACTOR,
      password: "two",
    });
    const a2 = await fs.resolveReadAccess("home", "s.txt");
    if (a1.access !== "password" || a2.access !== "password") {
      throw new Error("expected password access");
    }
    expect(a2.secret).not.toBe(a1.secret);
    expect(await verifySharePassword("two", a2.passwordHash)).toBe(true);
    expect(await verifySharePassword("one", a2.passwordHash)).toBe(false);
  });

  afterAll(async () => {
    rmSync(ASSETS_DIR, { recursive: true, force: true });
    if (db) await closeTestPgDatabase(db);
  });
});
