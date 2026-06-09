/**
 * WebDAV serve layer — integration tier. Exercises the FULL daemon read path
 * with no mocks: WebDAV handler → OrgFsClient → (in-process) mesh
 * `/api/:org/fs/*` routes + real `resolveOrgFromPath` → real `OrgFs` (real
 * Postgres + DevObjectStorage). Only the NFS kernel mount is out of scope here
 * (covered by the manual end-to-end harness `.context/webdav-nfs-smoke`).
 *
 * Local run:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres \
 *     bun test apps/mesh/src/file-storage/mount/webdav.integration.test.ts
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
import { resolveOrgFromPath } from "../../api/middleware/resolve-org-from-path";
import { createOrgFsRoutes } from "../../api/routes/org-fs";
import type { StudioContext } from "../../core/studio-context";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import { OrgFsEntryStorage } from "../../storage/org-fs";
import { OrgFsClient } from "./client";
import { createWebdavHandler } from "./webdav";

const ORG = "org_wd";
const SLUG = "wdtest";
const USER = "user_wd";
const VOLUME = "skills";
const ASSETS_DIR = `./data/assets/${ORG}`;

type Variables = { meshContext: StudioContext };

function buildMeshApp(db: StudioDatabase) {
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", async (c, next) => {
    c.set("meshContext", {
      auth: { user: { id: USER } },
      db: db.db,
      baseUrl: "http://test",
      access: {
        setOrganizationId: () => {},
        setRole: () => {},
        check: async () => {},
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
  await sql`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (${ORG}, ${ORG}, ${SLUG}, ${now})`.execute(
    db.db,
  );
  await sql`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt") VALUES (${USER}, ${USER + "@t.co"}, 'U', false, ${now}, ${now})`.execute(
    db.db,
  );
  await sql`INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt") VALUES ('mem_wd', ${USER}, ${ORG}, 'member', ${now})`.execute(
    db.db,
  );
}

describe("WebDAV serve layer (integration, full chain)", () => {
  let db: StudioDatabase;
  let dav: (req: Request) => Promise<Response>;

  const req = (path: string, init?: RequestInit) =>
    dav(new Request(`http://dav${path}`, init));

  beforeAll(async () => {
    db = await connectTestPgDatabase();
  });

  beforeEach(async () => {
    await resetTestPgDatabase(db);
    await seed(db);
    rmSync(ASSETS_DIR, { recursive: true, force: true });
    const app = buildMeshApp(db);
    const client = new OrgFsClient({
      baseUrl: "http://test",
      orgSlug: SLUG,
      volume: VOLUME,
      token: "test-token",
      fetch: (url, reqInit) => Promise.resolve(app.request(url, reqInit)),
    });
    dav = createWebdavHandler(client);
  });

  afterAll(async () => {
    rmSync(ASSETS_DIR, { recursive: true, force: true });
    if (db) await closeTestPgDatabase(db);
  });

  it("advertises WebDAV on OPTIONS", async () => {
    const res = await req("/", { method: "OPTIONS" });
    expect(res.status).toBe(200);
    expect(res.headers.get("dav")).toContain("1");
    expect(res.headers.get("allow")).toContain("PROPFIND");
  });

  it("PUT then GET round-trips bytes", async () => {
    expect(
      (await req("/hello.txt", { method: "PUT", body: "world" })).status,
    ).toBe(201);
    const get = await req("/hello.txt");
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("world");
  });

  it("PROPFIND lists a directory (Depth 1) with sizes + resourcetype", async () => {
    await req("/a.txt", { method: "PUT", body: "12345" });
    await req("/sub", { method: "MKCOL" });
    const res = await req("/", { method: "PROPFIND", headers: { depth: "1" } });
    expect(res.status).toBe(207);
    const xml = await res.text();
    expect(xml).toContain("<D:href>/a.txt</D:href>");
    expect(xml).toContain("<D:getcontentlength>5</D:getcontentlength>");
    expect(xml).toContain("<D:href>/sub/</D:href>");
    expect(xml).toContain("<D:collection/>");
  });

  it("PROPFIND 404s a missing path", async () => {
    const res = await req("/nope", {
      method: "PROPFIND",
      headers: { depth: "0" },
    });
    expect(res.status).toBe(404);
  });

  it("MKCOL creates a collection and nests files under it", async () => {
    expect((await req("/docs", { method: "MKCOL" })).status).toBe(201);
    await req("/docs/readme.md", { method: "PUT", body: "# hi" });
    const res = await req("/docs", {
      method: "PROPFIND",
      headers: { depth: "1" },
    });
    expect(await res.text()).toContain("<D:href>/docs/readme.md</D:href>");
  });

  it("MOVE renames a file", async () => {
    await req("/from.txt", { method: "PUT", body: "payload" });
    const mv = await req("/from.txt", {
      method: "MOVE",
      headers: { destination: "http://dav/to.txt" },
    });
    expect(mv.status).toBe(201);
    expect((await req("/from.txt")).status).toBe(404);
    expect(await (await req("/to.txt")).text()).toBe("payload");
  });

  it("DELETE removes a file", async () => {
    await req("/gone.txt", { method: "PUT", body: "x" });
    expect((await req("/gone.txt", { method: "DELETE" })).status).toBe(204);
    expect((await req("/gone.txt")).status).toBe(404);
  });

  it("serves a byte range (206)", async () => {
    await req("/r.txt", { method: "PUT", body: "0123456789" });
    const res = await req("/r.txt", { headers: { range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await res.text()).toBe("2345");
  });

  it("HEAD returns size without a body", async () => {
    await req("/h.txt", { method: "PUT", body: "abcdef" });
    const res = await req("/h.txt", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("6");
    expect(await res.text()).toBe("");
  });
});
