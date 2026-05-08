import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { MeshContext } from "../../core/mesh-context";
import {
  closeTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "../../database/test-db";
import { createTestSchema } from "../../storage/test-helpers";
import { resolveOrgFromPath } from "./resolve-org-from-path";

type Variables = { meshContext: MeshContext };

interface FakeAuth {
  user?: { id: string };
  apiKey?: { id: string; name: string; userId: string };
}

const buildApp = (db: TestDatabase, auth: FakeAuth) => {
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", async (c, next) => {
    // Track the organization id forwarded into AccessControl so tests can
    // assert that path-resolved org propagates through to permission checks.
    const accessOrgIds: (string | undefined)[] = [];
    // Track threads.setOrganizationId calls so tests can assert that the
    // path-resolved org also rebinds OrgScopedThreadStorage. Without this
    // rebind, any thread-touching route on the new path family throws
    // "OrgScopedThreadStorage: thread operations require an authenticated organization".
    const threadOrgIds: (string | undefined)[] = [];
    c.set("meshContext", {
      auth,
      db: db.db,
      baseUrl: "http://test",
      access: {
        setOrganizationId: (id: string | undefined) => {
          accessOrgIds.push(id);
        },
        setRole: (_role: string | undefined) => {
          /* no-op for tests; covered by dedicated AccessControl tests */
        },
        // Expose the captured ids for tests via a non-standard field
        _orgIds: accessOrgIds,
      },
      storage: {
        threads: {
          setOrganizationId: (id: string | undefined) => {
            threadOrgIds.push(id);
          },
          _orgIds: threadOrgIds,
        },
      },
      objectStorage: null,
    } as unknown as MeshContext);
    await next();
  });
  app.use("/api/:org/*", resolveOrgFromPath);
  app.get("/api/:org/probe", (c) => {
    const ctx = c.get("meshContext");
    return c.json({
      orgId: ctx.organization?.id,
      orgSlug: ctx.organization?.slug,
      // Surface the rebound storage org ids so tests can assert middleware
      // propagated the org into MeshStorage.
      threadOrgIds: (
        ctx.storage.threads as unknown as { _orgIds: (string | undefined)[] }
      )._orgIds,
      objectStorageBound: ctx.objectStorage !== null,
    });
  });
  return app;
};

describe("resolveOrgFromPath", () => {
  let db: TestDatabase;

  beforeEach(async () => {
    db = await createTestDatabase();
    await createTestSchema(db.db);

    // Seed an org "acme" with id "org-1" and a member "user-1".
    await db.db
      .insertInto("organization")
      .values({
        id: "org-1",
        slug: "acme",
        name: "Acme",
        createdAt: new Date().toISOString(),
      })
      .execute();
    await db.db
      .insertInto("user")
      .values({
        id: "user-1",
        email: "u@acme.test",
        name: "U",
        emailVerified: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .execute();
    await db.db
      .insertInto("member")
      .values({
        id: "mem-1",
        userId: "user-1",
        organizationId: "org-1",
        role: "member",
        createdAt: new Date().toISOString(),
      })
      .execute();
  });

  afterEach(async () => {
    await closeTestDatabase(db);
  });

  it("returns 404 when slug does not exist", async () => {
    const app = buildApp(db, { user: { id: "user-1" } });
    const res = await app.request("/api/nope/probe");
    expect(res.status).toBe(404);
  });

  it("returns 403 when user is not a member", async () => {
    await db.db
      .insertInto("organization")
      .values({
        id: "org-2",
        slug: "other",
        name: "Other",
        createdAt: new Date().toISOString(),
      })
      .execute();
    const app = buildApp(db, { user: { id: "user-1" } });
    const res = await app.request("/api/other/probe");
    expect(res.status).toBe(403);
  });

  it("sets ctx.organization on success", async () => {
    const app = buildApp(db, { user: { id: "user-1" } });
    const res = await app.request("/api/acme/probe");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orgId).toBe("org-1");
    expect(body.orgSlug).toBe("acme");
  });

  it("exposes the caller's path-resolved role on ctx.organization", async () => {
    // AuthTransport constructs a fresh AccessControl per proxied tool call
    // and reads the role from ctx.organization?.role to decide the
    // admin/owner bypass — without this, owners 403 on every proxied tool
    // when the session's active org differs from the URL org.
    const app = new Hono<{ Variables: Variables }>();
    app.use("*", async (c, next) => {
      c.set("meshContext", {
        auth: { user: { id: "user-1" } },
        db: db.db,
        baseUrl: "http://test",
        access: {
          setOrganizationId: () => {},
          setRole: () => {},
        },
        storage: { threads: { setOrganizationId: () => {} } },
        objectStorage: null,
      } as unknown as MeshContext);
      await next();
    });
    app.use("/api/:org/*", resolveOrgFromPath);
    app.get("/api/:org/role", (c) => {
      const ctx = c.get("meshContext");
      return c.json({ role: ctx.organization?.role });
    });
    const res = await app.request("/api/acme/role");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "member" });
  });

  it("passes unauthenticated requests through with org set (so MCP OAuth discovery works)", async () => {
    // Cursor/Claude rely on mcpAuth returning 401 with a WWW-Authenticate header
    // pointing at the protected-resource metadata URL. If this middleware blocks
    // unauthenticated callers with 403, OAuth discovery never starts.
    const app = buildApp(db, { user: undefined });
    const res = await app.request("/api/acme/probe");
    expect(res.status).toBe(200); // probe handler doesn't enforce auth
    const body = await res.json();
    expect(body.orgId).toBe("org-1"); // org is set so downstream handlers can use it
  });

  it("rebinds storage.threads + objectStorage to the path-resolved org", async () => {
    // Regression: when the new /api/:org path is hit without an x-org-id
    // header, meshContext is created with org=undefined, so OrgScopedThreadStorage
    // and objectStorage start out unbound. resolveOrgFromPath must rebind both
    // after looking up the org from the slug, otherwise thread routes throw
    // "thread operations require an authenticated organization".
    const app = buildApp(db, { user: { id: "user-1" } });
    const res = await app.request("/api/acme/probe");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.threadOrgIds).toEqual(["org-1"]);
    expect(body.objectStorageBound).toBe(true);
  });

  it("authorizes api-key principals via the same membership check", async () => {
    // For api-key auth, the context-factory populates ctx.auth.user.id from
    // the api key's userId, so a single membership check covers both flows.
    const app = buildApp(db, {
      user: { id: "user-1" },
      apiKey: { id: "key-1", name: "test-key", userId: "" },
    });
    const res = await app.request("/api/acme/probe");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orgId).toBe("org-1");
  });
});
