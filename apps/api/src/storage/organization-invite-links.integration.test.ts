import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
} from "../database/test-db-pg";
import { OrganizationInviteLinkStorage } from "./organization-invite-links";

const HOUR = 60 * 60 * 1000;

describe("OrganizationInviteLinkStorage (real Postgres)", () => {
  let database: StudioDatabase;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
  });

  afterAll(async () => {
    if (database) await closeTestPgDatabase(database);
  });

  async function org() {
    const id = `org_${crypto.randomUUID()}`;
    await sql`
      INSERT INTO "organization" (id, name, slug, "createdAt")
      VALUES (${id}, ${id}, ${id}, ${new Date().toISOString()})
    `.execute(database.db);
    return id;
  }

  function link(
    storage: OrganizationInviteLinkStorage,
    organizationId: string,
    expiresInMs = 24 * HOUR,
  ) {
    return storage.create({
      organizationId,
      tokenHash: `hash_${crypto.randomUUID()}`,
      role: "user",
      redirectPath: `/${organizationId}/apps/x`,
      createdBy: null,
      expiresAt: new Date(Date.now() + expiresInMs),
    });
  }

  test("create round-trips and is found by its token digest", async () => {
    const storage = new OrganizationInviteLinkStorage(database.db);
    const orgId = await org();
    const created = await storage.create({
      organizationId: orgId,
      tokenHash: "digest-roundtrip",
      role: "user",
      redirectPath: `/${orgId}`,
      createdBy: null,
      expiresAt: new Date(Date.now() + HOUR),
    });

    const found = await storage.findByTokenHash("digest-roundtrip");
    expect(found).toMatchObject({
      id: created.id,
      organizationId: orgId,
      role: "user",
      redirectPath: `/${orgId}`,
      revokedAt: null,
      useCount: 0,
    });
    expect(found?.expiresAt).toBeInstanceOf(Date);
    expect(await storage.findByTokenHash("unknown-digest")).toBeNull();
  });

  test("listActive skips expired and revoked links, newest first", async () => {
    const storage = new OrganizationInviteLinkStorage(database.db);
    const orgId = await org();
    const older = await link(storage, orgId);
    const newer = await link(storage, orgId);
    await link(storage, orgId, -HOUR);
    const revoked = await link(storage, orgId);
    await storage.revoke(revoked.id, orgId);

    const ids = (await storage.listActive(orgId)).map((l) => l.id);
    expect(ids).toEqual([newer.id, older.id]);
  });

  test("revoke is scoped to the org and only succeeds once", async () => {
    const storage = new OrganizationInviteLinkStorage(database.db);
    const orgId = await org();
    const otherOrg = await org();
    const created = await link(storage, orgId);

    expect(await storage.revoke(created.id, otherOrg)).toBe(false);
    expect(await storage.revoke(created.id, orgId)).toBe(true);
    expect(await storage.revoke(created.id, orgId)).toBe(false);
  });

  test("concurrent uses are all counted", async () => {
    const storage = new OrganizationInviteLinkStorage(database.db);
    const orgId = await org();
    const created = await link(storage, orgId);

    await Promise.all(
      Array.from({ length: 5 }, () => storage.incrementUse(created.id)),
    );
    const [active] = await storage.listActive(orgId);
    expect(active?.useCount).toBe(5);
  });

  test("links are deleted with their organization", async () => {
    const storage = new OrganizationInviteLinkStorage(database.db);
    const orgId = await org();
    await storage.create({
      organizationId: orgId,
      tokenHash: `digest-cascade-${orgId}`,
      role: "user",
      redirectPath: null,
      createdBy: null,
      expiresAt: new Date(Date.now() + HOUR),
    });

    await sql`DELETE FROM "organization" WHERE id = ${orgId}`.execute(
      database.db,
    );
    expect(await storage.findByTokenHash(`digest-cascade-${orgId}`)).toBeNull();
  });
});
