/**
 * Real-Postgres coverage for `status_mapping`, which is jsonb and therefore
 * the one part of this row an in-memory fake cannot tell you the truth about:
 * Postgres orders jsonb object keys by length and then bytes, and it is exactly
 * that ordering the old status → lane shape leaned on to pick a push target.
 *
 * Two properties are pinned here. A mapping written in the array shape reads
 * back with each lane's statuses in the order they were written, because the
 * push sends a card entering a lane to position 0 — note "QA" precedes "Code
 * Review" in jsonb key order, so a reader leaning on that would hand back the
 * wrong target. And a row still holding the pre-array shape reads back
 * normalized, which keeps a rolling deploy syncing while migration 178 lands.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../database/test-db-pg";
import { CredentialVault } from "../encryption/credential-vault";
import { JiraIntegrationStorage } from "./jira-integrations";

const ORG = "org_jira_map_1";
const USER = "user_jm1";

describe("jira integration status mapping", () => {
  let database: StudioDatabase;
  let storage: JiraIntegrationStorage;

  const write = (statusMapping: Record<string, string[]>) =>
    storage.upsert({
      organizationId: ORG,
      siteUrl: "https://example.atlassian.net",
      email: "sync@example.test",
      apiToken: "token",
      boardId: "1",
      boardName: "Board",
      statusMapping,
      jqlFilter: null,
      autoDelegate: false,
      enabled: false,
      createdBy: USER,
    });

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({ id: ORG, name: ORG, slug: "org-jira-map-1", createdAt: now })
      .execute();
    // Raw SQL: real Postgres has a BOOLEAN emailVerified the typed shape disagrees with.
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"jm1@map.test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    storage = new JiraIntegrationStorage(
      database.db,
      new CredentialVault("0".repeat(64)),
    );
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("round-trips a lane's statuses in the order they were written", async () => {
    const mapping = {
      triage: ["Backlog"],
      in_review: ["Code Review", "QA"],
      done: ["Released", "Closed"],
    };
    const written = await write(mapping);
    expect(written.statusMapping).toEqual(mapping);

    const read = await storage.getByOrg(ORG);
    expect(read?.statusMapping.in_review).toEqual(["Code Review", "QA"]);
    expect(read?.statusMapping.done).toEqual(["Released", "Closed"]);
  });

  it("normalizes a pre-array row, without inventing an order it cannot know", async () => {
    await write({ triage: ["Backlog"] });
    await sql`
      UPDATE org_jira_integrations
         SET status_mapping = ${sql.lit(
           JSON.stringify({
             Backlog: "triage",
             "Code Review": "in_review",
             QA: "in_review",
           }),
         )}::jsonb
       WHERE organization_id = ${ORG}
    `.execute(database.db);

    const read = await storage.getByOrg(ORG);
    expect(Object.keys(read?.statusMapping ?? {}).sort()).toEqual([
      "in_review",
      "triage",
    ]);
    expect(read?.statusMapping.triage).toEqual(["Backlog"]);
    expect([...(read?.statusMapping.in_review ?? [])].sort()).toEqual([
      "Code Review",
      "QA",
    ]);
  });

  it("reads an empty mapping as empty rather than throwing", async () => {
    await write({});
    expect((await storage.getByOrg(ORG))?.statusMapping).toEqual({});
  });
});
