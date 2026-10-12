/**
 * claimProjectFolder over a real manifest + DevObjectStorage. See TESTING.md
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
import {
  claimProjectFolder,
  deleteProjectFolder,
  scaffoldProjectFolder,
} from "./project-folder";

const ORG = "org_project_folder";
const ACTOR = "user_project_folder";
const ASSETS_DIR = `./data/assets/${ORG}`;
const PROJECT = { id: "vir_1", title: "Acme Store" };

describe("claimProjectFolder (integration)", () => {
  let db: StudioDatabase;
  let fs: OrgFs;

  const names = async (dir: string) =>
    (await fs.listDir(HOME_MOUNT_PATH, dir)).map((e) => `${e.kind}:${e.path}`);
  const text = async (path: string) =>
    new TextDecoder().decode(await fs.read(HOME_MOUNT_PATH, path));
  const claim = (
    project: { id: string; title?: string; metadata?: unknown },
    projects: { id: string; title?: string; metadata?: unknown }[] = [project],
  ) =>
    claimProjectFolder({
      orgFs: fs,
      organizationId: ORG,
      project,
      projects,
      homeIsSynced: false,
      actor: ACTOR,
    });

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
    expect(await claim(PROJECT)).toBe("acme-store");
    expect((await names("projects/acme-store")).toSorted()).toEqual([
      "dir:projects/acme-store/Delivered",
      "dir:projects/acme-store/Documents",
      "dir:projects/acme-store/Notes",
      "dir:projects/acme-store/Work",
      "file:projects/acme-store/memory.md",
    ]);
    expect(await text("projects/acme-store/memory.md")).toStartWith(
      "# Acme Store\n",
    );
  });

  it("never overwrites memory.md or touches other files", async () => {
    await fs.write(HOME_MOUNT_PATH, "projects/acme-store/memory.md", "mine", {
      actor: ACTOR,
    });
    await fs.write(HOME_MOUNT_PATH, "projects/acme-store/notes.txt", "keep", {
      actor: ACTOR,
    });

    await claim(PROJECT);

    expect(await text("projects/acme-store/memory.md")).toBe("mine");
    expect(await names("projects/acme-store")).toContain(
      "file:projects/acme-store/notes.txt",
    );
  });

  it("keeps a memory.md that lands between the listing and the write", async () => {
    const listDir = fs.listDir.bind(fs);
    fs.listDir = async (volume, path) => {
      const entries = await listDir(volume, path);
      await fs.write(HOME_MOUNT_PATH, `${path}/memory.md`, "raced", {
        actor: ACTOR,
      });
      return entries;
    };

    await scaffoldProjectFolder(fs, "projects/acme-store", "Acme", ACTOR);

    expect(await text("projects/acme-store/memory.md")).toBe("raced");
  });

  it("checks presence against the normalized folder", async () => {
    const nested = {
      ...PROJECT,
      metadata: { project: { folder: "Clients/" } },
    };
    await fs.write(
      HOME_MOUNT_PATH,
      "projects/Clients/acme-store/memory.md",
      "mine",
      { actor: ACTOR },
    );

    await claim(nested);

    expect(await text("projects/Clients/acme-store/memory.md")).toBe("mine");
  });

  it("never writes outside projects/", async () => {
    const escaping = {
      ...PROJECT,
      metadata: {
        project: { folder: "../skills" },
        projectFolderName: "..",
      },
    };

    expect(await claim(escaping)).toBe("acme-store");
    expect(await names("skills")).toEqual([]);
    expect(await names("projects")).toEqual(["dir:projects/acme-store"]);
  });

  it("gives a project whose title folds onto another's its own folder", async () => {
    const other = {
      id: "vir_2",
      title: "Acme  Store!",
      metadata: { projectFolderName: "acme-store" },
    };

    expect(await claim(PROJECT, [PROJECT, other])).toBe("acme-store-2");
    expect(await names("projects/acme-store-2")).toContain(
      "file:projects/acme-store-2/memory.md",
    );
  });

  it("leaves a pinned project's folder as it is", async () => {
    const name = await claim(PROJECT);
    const pinned = { ...PROJECT, metadata: { projectFolderName: name } };
    await fs.delete(HOME_MOUNT_PATH, "projects/acme-store/Notes", {
      actor: ACTOR,
    });
    const before = await fs.latestSeq(HOME_MOUNT_PATH);

    expect(await claim(pinned)).toBeNull();
    expect(await names("projects/acme-store")).not.toContain(
      "dir:projects/acme-store/Notes",
    );
    expect(await fs.latestSeq(HOME_MOUNT_PATH)).toBe(before);
  });

  it("pins without writing when home is a repo-sync mirror", async () => {
    const name = await claimProjectFolder({
      orgFs: fs,
      organizationId: ORG,
      project: PROJECT,
      projects: [PROJECT],
      homeIsSynced: true,
      actor: ACTOR,
    });

    expect(name).toBe("acme-store");
    expect(await names("projects")).toEqual([]);
  });

  it("deletes only a pinned folder with its project", async () => {
    const name = await claim(PROJECT);
    await deleteProjectFolder(fs, ORG, PROJECT, ACTOR);
    expect(await names("projects")).toEqual(["dir:projects/acme-store"]);

    await deleteProjectFolder(
      fs,
      ORG,
      { ...PROJECT, metadata: { projectFolderName: name } },
      ACTOR,
    );
    expect(await names("projects")).toEqual([]);
  });
});
