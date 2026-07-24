/**
 * Skill catalog detection — storage-integration tier (real Postgres + real
 * object storage, zero mocks). Exercises `detectSkills` over the OrgFs
 * manifest end to end. See TESTING.md.
 *
 * Local run:
 *   docker run -d --name pg -p 5432:5432 -e POSTGRES_USER=postgres \
 *     -e POSTGRES_PASSWORD=postgres postgres:16
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
 *     bun run --cwd=apps/api migrate
 *   DATABASE_URL=... bun test apps/api/src/file-storage/skill-catalog.integration.test.ts
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
import { detectSkills } from "./skill-catalog";
import { OrgFs } from "./org-fs";

const ORG = "org_skill_catalog";
const ACTOR = "user_skill_catalog";
const VOL = "home";
// DevObjectStorage writes bytes under ./data/assets/<org>/ — clean it up so the
// test never leaves artifacts in the working tree (data/ is gitignored too).
const ASSETS_DIR = `./data/assets/${ORG}`;

function buildFs(db: StudioDatabase) {
  return new OrgFs(
    new DevObjectStorage(ORG, "http://test"),
    new OrgFsEntryStorage(db.db),
    ORG,
  );
}

async function seedOrg(db: StudioDatabase) {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO "organization" (id, name, slug, "createdAt")
    VALUES (${ORG}, ${ORG}, ${ORG}, ${now})
    ON CONFLICT (id) DO NOTHING
  `.execute(db.db);
}

describe("detectSkills (integration)", () => {
  let db: StudioDatabase;
  let fs: OrgFs;

  beforeAll(async () => {
    db = await connectTestPgDatabase();
    await seedOrg(db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(db);
    rmSync(ASSETS_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetTestPgDatabase(db);
    await seedOrg(db);
    fs = buildFs(db);
  });

  const budget = () => ({ remaining: 200 });

  it("detects frontmatter and plain skills, with name fallback", async () => {
    await fs.write(
      VOL,
      "slides/SKILL.md",
      "---\nname: slides\ndescription: Make decks.\n---\n\n# slides\n",
      { actor: ACTOR },
    );
    await fs.write(VOL, "pdf/SKILL.md", "# pdf — docs\n\nRead PDFs.\n", {
      actor: ACTOR,
    });

    const out = await detectSkills(fs, VOL, "", budget());
    const byDir = new Map(out.map((s) => [s.dirPath, s]));
    expect(byDir.get("slides")).toEqual({
      dirPath: "slides",
      name: "slides",
      description: "Make decks.",
    });
    expect(byDir.get("pdf")).toEqual({
      dirPath: "pdf",
      name: "pdf", // frontmatter absent → dir basename
      description: "Read PDFs.",
    });
  });

  it("skips dirs without a SKILL.md and tombstoned SKILL.md", async () => {
    await fs.write(VOL, "real/SKILL.md", "# real\n\nA skill.\n", {
      actor: ACTOR,
    });
    await fs.mkdir(VOL, "plain", { actor: ACTOR });
    await fs.write(VOL, "gone/SKILL.md", "# gone\n", { actor: ACTOR });
    await fs.delete(VOL, "gone/SKILL.md", { actor: ACTOR });

    const out = await detectSkills(fs, VOL, "", budget());
    expect(out.map((s) => s.dirPath).sort()).toEqual(["real"]);
  });

  it("scans a nested base (skills/) and returns volume-relative dirPaths", async () => {
    await fs.write(VOL, "skills/onboarding/SKILL.md", "# onboarding\n\nHi.\n", {
      actor: ACTOR,
    });
    const out = await detectSkills(fs, VOL, "skills", budget());
    expect(out.map((s) => s.dirPath)).toEqual(["skills/onboarding"]);
  });

  it("returns [] for an empty / nonexistent base and never throws", async () => {
    expect(await detectSkills(fs, VOL, "", budget())).toEqual([]);
    expect(await detectSkills(fs, VOL, "does-not-exist", budget())).toEqual([]);
  });

  it("respects the read budget cap", async () => {
    for (const n of ["a", "b", "c"]) {
      await fs.write(VOL, `${n}/SKILL.md`, `# ${n}\n\ndesc\n`, {
        actor: ACTOR,
      });
    }
    const out = await detectSkills(fs, VOL, "", { remaining: 2 });
    expect(out.length).toBe(2);
  });
});
