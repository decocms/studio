import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { TaskBoardStorage } from "./task-board";

/**
 * Real-Postgres coverage for `external_url` — the link to the card's issue in
 * the tracker it came from, which used to be the first line of the card's
 * DESCRIPTION and therefore of every agent run's prompt.
 *
 * Real Postgres rather than a fake because `update()` writes through an
 * explicit column whitelist: a fake accepts the field and hands back the object
 * it was given, so it would agree with a version that silently drops the write
 * — which is precisely how the Jira pull keeps the link current.
 */
const ORG = "org_external_url_1";
const USER = "user_external_url";
const URL = "https://example.atlassian.net/browse/EX-333";

describe("TaskBoardStorage — externalUrl", () => {
  let database: StudioDatabase;
  let storage: TaskBoardStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const createdAt = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${`${USER}@test.com`}, false, 'External Url', ${createdAt}, ${createdAt})
    `.execute(database.db);
    await database.db
      .insertInto("organization")
      .values({ id: ORG, name: ORG, slug: "external-url-one", createdAt })
      .execute();
    storage = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("persists the tracker link a synced card is created with", async () => {
    const created = await storage.create({
      organizationId: ORG,
      title: "From Jira",
      description: "The issue body, and nothing else.",
      externalUrl: URL,
      by: "jira",
    });

    expect(created.externalUrl).toBe(URL);
    const read = await storage.getById(created.id, ORG);
    expect(read?.externalUrl).toBe(URL);
    expect(read?.description).toBe("The issue body, and nothing else.");
  });

  it("carries null for a card Studio owns", async () => {
    const own = await storage.create({
      organizationId: ORG,
      title: "Written in Studio",
      by: USER,
    });

    expect(own.externalUrl).toBeNull();
    expect((await storage.getById(own.id, ORG))?.externalUrl).toBeNull();
  });

  it("updates the link, and clears it, through the column whitelist", async () => {
    const item = await storage.create({
      organizationId: ORG,
      title: "Relinked",
      by: "jira",
    });

    const linked = await storage.update(
      item.id,
      ORG,
      { externalUrl: URL },
      "jira",
    );
    expect(linked.externalUrl).toBe(URL);
    expect((await storage.getById(item.id, ORG))?.externalUrl).toBe(URL);

    const cleared = await storage.update(
      item.id,
      ORG,
      { externalUrl: null },
      "jira",
    );
    expect(cleared.externalUrl).toBeNull();
    expect((await storage.getById(item.id, ORG))?.externalUrl).toBeNull();
  });

  it("leaves the link alone on an update that does not mention it", async () => {
    const item = await storage.create({
      organizationId: ORG,
      title: "Untouched",
      externalUrl: URL,
      by: "jira",
    });

    const renamed = await storage.update(
      item.id,
      ORG,
      { title: "Renamed" },
      USER,
    );

    expect(renamed.externalUrl).toBe(URL);
  });
});
