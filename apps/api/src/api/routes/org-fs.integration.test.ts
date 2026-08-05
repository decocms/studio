/**
 * Org filesystem HTTP routes — integration tier. Drives the real Hono router
 * + the real `resolveOrgFromPath` middleware (which rebinds `ctx.orgFs` to the
 * path org) over a REAL OrgFs (real manifest in Postgres + DevObjectStorage).
 *
 * `access` is the one inert collaborator (no-op grant) — RBAC resolution is
 * covered by access-control's own tests; here we test the route ↔ OrgFs wiring,
 * the middleware orgFs rebind, and HTTP status mapping. Auth/membership are
 * enforced by the real middleware + the route's explicit guards.
 *
 * Local run (no S3 env → DevObjectStorage):
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
 *     bun test apps/api/src/api/routes/org-fs.integration.test.ts
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
import { Hono } from "hono";
import { sql } from "kysely";
import type { StudioContext } from "../../core/studio-context";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import { ForbiddenError } from "../../core/access-control";
import { OrgFsEntryStorage } from "../../storage/org-fs";
import { resolveOrgFromPath } from "../middleware/resolve-org-from-path";
import { createOrgFsRoutes } from "./org-fs";

const ORG = "org_fs_api";
const SLUG = "fsapi";
const USER = "user_fs_api";
const ASSETS_DIR = `./data/assets/${ORG}`;
const BASE = `/api/${SLUG}/fs`;

type Variables = { studioContext: StudioContext };

function buildApp(
  db: StudioDatabase,
  authed: boolean,
  opts: {
    accessCheck?: () => Promise<void>;
    /** Mimic app.ts's global handler that 500s every *thrown* error. */
    swallowOnError?: boolean;
  } = {},
) {
  const app = new Hono<{ Variables: Variables }>();
  if (opts.swallowOnError) {
    app.onError((err, c) =>
      c.json(
        { error: "Internal Server Error", message: (err as Error).message },
        500,
      ),
    );
  }
  app.use("*", async (c, next) => {
    c.set("studioContext", {
      auth: authed ? { user: { id: USER } } : {},
      db: db.db,
      baseUrl: "http://test",
      access: {
        setOrganizationId: () => {},
        setRole: () => {},
        check: opts.accessCheck ?? (async () => {}),
      },
      storage: {
        threads: { setOrganizationId: () => {} },
        asyncResearchJobs: { setOrganizationId: () => {} },
        orgFsEntries: new OrgFsEntryStorage(db.db),
      },
      objectStorage: null,
      orgFs: null,
    } as unknown as StudioContext);
    await next();
  });
  app.use("/api/:org/*", resolveOrgFromPath);
  app.route("/api/:org/fs", createOrgFsRoutes());
  return app;
}

async function seed(db: StudioDatabase) {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO "organization" (id, name, slug, "createdAt")
    VALUES (${ORG}, ${ORG}, ${SLUG}, ${now})
  `.execute(db.db);
  await sql`
    INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
    VALUES (${USER}, ${USER + "@test.com"}, 'U', false, ${now}, ${now})
  `.execute(db.db);
  await sql`
    INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
    VALUES ('mem_fs_api', ${USER}, ${ORG}, 'member', ${now})
  `.execute(db.db);
}

describe("org-fs HTTP routes (integration)", () => {
  let db: StudioDatabase;
  let app: Hono<{ Variables: Variables }>;

  beforeAll(async () => {
    db = await connectTestPgDatabase();
  });

  beforeEach(async () => {
    await resetTestPgDatabase(db);
    await seed(db);
    rmSync(ASSETS_DIR, { recursive: true, force: true });
    app = buildApp(db, true);
  });

  afterAll(async () => {
    rmSync(ASSETS_DIR, { recursive: true, force: true });
    if (db) await closeTestPgDatabase(db);
  });

  const put = (path: string, body: string) =>
    app.request(`${BASE}/skills/file?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      body,
    });

  it("writes then reads a file through the mounted router", async () => {
    const wrote = await put("hello.txt", "hi there");
    expect(wrote.status).toBe(200);
    const { entry } = await wrote.json();
    expect(entry.path).toBe("hello.txt");
    expect(entry.size).toBe(8);

    const read = await app.request(`${BASE}/skills/read?path=hello.txt`);
    expect(read.status).toBe(200);
    expect(await read.text()).toBe("hi there");
  });

  it("lists a directory and stats an entry", async () => {
    await put("docs/readme.md", "# hi");
    const list = await app.request(`${BASE}/skills/list?path=docs`);
    expect(list.status).toBe(200);
    const { entries } = await list.json();
    expect(entries.map((e: { path: string }) => e.path)).toEqual([
      "docs/readme.md",
    ]);

    const stat = await app.request(`${BASE}/skills/stat?path=docs/readme.md`);
    expect(stat.status).toBe(200);
    expect((await stat.json()).entry.kind).toBe("file");

    const missing = await app.request(`${BASE}/skills/stat?path=nope.txt`);
    expect(missing.status).toBe(404);
  });

  it("returns a presigned URL when ?presign=1", async () => {
    await put("p.txt", "data");
    const res = await app.request(`${BASE}/skills/read?path=p.txt&presign=1`);
    expect(res.status).toBe(200);
    const { url } = await res.json();
    // DevObjectStorage mints inline data: URLs.
    expect(url.startsWith("data:")).toBe(true);
  });

  it("creates a directory, then deletes a file", async () => {
    const mk = await app.request(`${BASE}/skills/dir?path=empty`, {
      method: "POST",
    });
    expect(mk.status).toBe(200);
    const listed = await (
      await app.request(`${BASE}/skills/list?path=`)
    ).json();
    expect(listed.entries.map((e: { path: string }) => e.path)).toContain(
      "empty",
    );

    await put("gone.txt", "x");
    const del = await app.request(`${BASE}/skills/file?path=gone.txt`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(
      (await app.request(`${BASE}/skills/stat?path=gone.txt`)).status,
    ).toBe(404);
  });

  // Manifest row present, bytes gone (a volume restored against a different
  // bucket) — a 404, not the 500 the raw storage error used to produce.
  it("404s a read whose stored bytes are missing", async () => {
    await put("orphan.txt", "bytes");
    rmSync(ASSETS_DIR, { recursive: true, force: true });

    expect(
      (await app.request(`${BASE}/skills/stat?path=orphan.txt`)).status,
    ).toBe(200);
    const read = await app.request(`${BASE}/skills/read?path=orphan.txt`);
    expect(read.status).toBe(404);
  });

  it("moves a file via POST /move", async () => {
    await put("a.txt", "payload");
    const mv = await app.request(`${BASE}/skills/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "a.txt", to: "b/c.txt" }),
    });
    expect(mv.status).toBe(200);
    expect((await app.request(`${BASE}/skills/stat?path=a.txt`)).status).toBe(
      404,
    );
    const moved = await app.request(`${BASE}/skills/read?path=b/c.txt`);
    expect(await moved.text()).toBe("payload");
  });

  it("404s a move whose source is missing", async () => {
    const mv = await app.request(`${BASE}/skills/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "missing.txt", to: "x.txt" }),
    });
    expect(mv.status).toBe(404);
  });

  it("exposes a change feed and usage", async () => {
    await put("one.txt", "1");
    await put("two.txt", "22");

    const changes = await (
      await app.request(`${BASE}/skills/changes?since=0`)
    ).json();
    expect(changes.entries.map((e: { path: string }) => e.path)).toEqual(
      expect.arrayContaining(["one.txt", "two.txt"]),
    );
    expect(changes.cursor).not.toBe("0");

    const usage = await (await app.request(`${BASE}/skills/usage`)).json();
    expect(usage).toEqual({ files: 2, bytes: 3 });
  });

  it("rejects writing to the volume root with 400", async () => {
    const res = await put("", "x");
    expect(res.status).toBe(400);
  });

  it("rejects an invalid volume name with 400", async () => {
    const res = await app.request(`${BASE}/ba!dvol/list?path=`);
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const anon = buildApp(db, false);
    const res = await anon.request(`${BASE}/skills/list?path=`);
    expect(res.status).toBe(401);
  });

  it("maps a denied access.check to 403", async () => {
    const denied = buildApp(db, true, {
      accessCheck: async () => {
        throw new ForbiddenError("nope");
      },
    });
    const res = await denied.request(`${BASE}/skills/list?path=`);
    expect(res.status).toBe(403);
  });

  it("preserves status codes under the app's swallow-all onError handler", async () => {
    // Regression: app.ts's global onError turns every THROWN error (incl.
    // HTTPException) into 500. The routes must return explicit responses so a
    // 404/400 isn't collapsed. This app mounts that hostile handler.
    const guarded = buildApp(db, true, { swallowOnError: true });
    const notFound = await guarded.request(
      `${BASE}/skills/stat?path=ghost.txt`,
    );
    expect(notFound.status).toBe(404);
    const badVolume = await guarded.request(`${BASE}/ba!dvol/list?path=`);
    expect(badVolume.status).toBe(400);
    const rootWrite = await guarded.request(`${BASE}/skills/file?path=`, {
      method: "PUT",
      body: "x",
    });
    expect(rootWrite.status).toBe(400);
  });
});
