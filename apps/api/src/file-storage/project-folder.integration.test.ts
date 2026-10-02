/**
 * ensureProjectFolder over a real manifest + DevObjectStorage. See TESTING.md
 * and `org-fs.integration.test.ts` for the local run.
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
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { DevObjectStorage } from "../object-storage/dev-object-storage";
import { OrgFsEntryStorage } from "../storage/org-fs";
import { OrgFs } from "./org-fs";
import { ensureProjectFolder } from "./project-folder";

const ORG = "org_project_folder";
const ACTOR = "user_project_folder";
const ASSETS_DIR = `./data/assets/${ORG}`;
const PROJECT = { id: "vir_1", title: "Farm BR" };

describe("ensureProjectFolder (integration)", () => {
  let db: StudioDatabase;
  let fs: OrgFs;

  const names = async (dir: string) =>
    (await fs.listDir(HOME_MOUNT_PATH, dir)).map((e) => `${e.kind}:${e.path}`);

  beforeAll(async () => {
    db = await connectTestPgDatabase();
  });

  beforeEach(async () => {
    await resetTestPgDatabase(db);
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${ORG}, ${ORG}, ${ORG}, ${new Date().toISOString()})
      ON CONFLICT (id) DO NOTHING
    `.execute(db.db);
    rmSync(ASSETS_DIR, { recursive: true, force: true });
    fs = new OrgFs(
      new DevObjectStorage(ORG, "http://test"),
      new OrgFsEntryStorage(db.db),
      ORG,
    );
  });

  afterAll(async () => {
    rmSync(ASSETS_DIR, { recursive: true, force: true });
    await closeTestPgDatabase(db);
  });

  it("creates the subfolders and memory.md under projects/<name>", async () => {
    const root = await ensureProjectFolder(fs, PROJECT, ACTOR);

    expect(root).toBe("projects/farm-br");
    expect((await names(root)).toSorted()).toEqual([
      "dir:projects/farm-br/Contracts",
      "dir:projects/farm-br/Documents",
      "dir:projects/farm-br/Meetings",
      "dir:projects/farm-br/Reports",
      "dir:projects/farm-br/Research",
      "file:projects/farm-br/memory.md",
    ]);
    const memory = await fs.read(HOME_MOUNT_PATH, `${root}/memory.md`);
    expect(new TextDecoder().decode(memory)).toStartWith("# Farm BR\n");
  });

  it("never overwrites memory.md or touches other files", async () => {
    await fs.write(HOME_MOUNT_PATH, "projects/farm-br/memory.md", "mine", {
      actor: ACTOR,
    });
    await fs.write(HOME_MOUNT_PATH, "projects/farm-br/notes.txt", "keep", {
      actor: ACTOR,
    });

    await ensureProjectFolder(fs, PROJECT, ACTOR);

    const memory = await fs.read(HOME_MOUNT_PATH, "projects/farm-br/memory.md");
    expect(new TextDecoder().decode(memory)).toBe("mine");
    expect(await names("projects/farm-br")).toContain(
      "file:projects/farm-br/notes.txt",
    );
  });

  it("restores a deleted subfolder and is a no-op when complete", async () => {
    await ensureProjectFolder(fs, PROJECT, ACTOR);
    await fs.delete(HOME_MOUNT_PATH, "projects/farm-br/Contracts", {
      actor: ACTOR,
    });

    await ensureProjectFolder(fs, PROJECT, ACTOR);
    const before = await fs.latestSeq(HOME_MOUNT_PATH);
    await ensureProjectFolder(fs, PROJECT, ACTOR);

    expect(await names("projects/farm-br")).toContain(
      "dir:projects/farm-br/Contracts",
    );
    expect(await fs.latestSeq(HOME_MOUNT_PATH)).toBe(before);
  });
});
