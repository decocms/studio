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
import { TaskBoardStorage } from "./task-board";

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

  /**
   * The watermark is what makes a repair reach nothing: an issue behind it is
   * never asked for again, so a widened mapping or a fixed renderer only
   * touches issues that happen to change afterwards. Clearing it has to leave
   * the row in the initial-import state — which is also the state that
   * suppresses auto-delegation, so a re-scan cannot dispatch a paid run per
   * pre-existing card.
   */
  it("clears the watermark without disturbing the rest of the row", async () => {
    const mapping = { in_review: ["QA", "Code Review"] };
    const written = await write(mapping);
    await storage.recordSyncResult(written.id, {
      error: "boom",
      watermark: new Date("2026-01-01T00:00:00Z"),
      rescanPending: true,
    });

    await storage.clearWatermark(written.id);

    const after = await storage.getByOrg(ORG);
    expect(after?.lastSyncedAt).toBe(null);
    expect(after?.lastSyncError).toBe(null);
    expect(after?.rescanPending).toBe(false);
    expect(after?.statusMapping).toEqual(mapping);
    expect(after?.boardId).toBe("1");
  });

  it("is a no-op on an id that is not this org's integration", async () => {
    const before = await storage.getByOrg(ORG);
    await storage.clearWatermark("jira_does_not_exist");
    expect(await storage.getByOrg(ORG)).toEqual(before);
  });

  it("reads an empty mapping as empty rather than throwing", async () => {
    await write({});
    expect((await storage.getByOrg(ORG))?.statusMapping).toEqual({});
  });
});

/**
 * The reconciliation sweep's input. Real Postgres because the whole point is
 * the join against the card's lane: an already-archived card must not come
 * back, or every tick would re-archive it and re-append to its timeline.
 */
describe("linked issues still on the board", () => {
  let database: StudioDatabase;
  let storage: JiraIntegrationStorage;
  let taskBoard: TaskBoardStorage;
  const ORG_R = "org_jira_rec_1";
  const USER_R = "user_jr1";

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({
        id: ORG_R,
        name: ORG_R,
        slug: "org-jira-rec-1",
        createdAt: now,
      })
      .execute();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER_R}, ${"jr1@rec.test"}, false, ${USER_R}, ${now}, ${now})
    `.execute(database.db);
    storage = new JiraIntegrationStorage(
      database.db,
      new CredentialVault("0".repeat(64)),
    );
    taskBoard = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  async function linkedCard(issueId: string, status: "todo" | "archived") {
    const item = await taskBoard.create({
      organizationId: ORG_R,
      title: `card for ${issueId}`,
      status,
      by: USER_R,
    });
    await storage.createLink({
      itemId: item.id,
      organizationId: ORG_R,
      jiraIssueId: issueId,
      jiraIssueKey: `OS-${issueId}`,
      jiraUpdatedAt: new Date(),
      jiraStatus: "BACKLOG",
    });
    return item;
  }

  it("lists live cards and leaves archived ones out", async () => {
    const live = await linkedCard("9001", "todo");
    await linkedCard("9002", "archived");

    const listed = await storage.listLinkedIssuesOnBoard(ORG_R);
    expect(listed.map((l) => l.jiraIssueId)).toEqual(["9001"]);
    expect(listed[0]).toEqual({
      itemId: live.id,
      jiraIssueId: "9001",
      jiraIssueKey: "OS-9001",
    });
  });

  it("is scoped to the org, so one tenant's sweep cannot reach another's", async () => {
    expect(await storage.listLinkedIssuesOnBoard("org_someone_else")).toEqual(
      [],
    );
  });

  /**
   * The card read has to carry the tracker's key, because that is what the
   * card shows. Real Postgres rather than a fake: the value is attached by a
   * batched second query over the link table, not selected off the item row,
   * so a fake that simply returns the item would agree with a version that
   * attaches nothing.
   */
  it("attaches the tracker key to a synced card, and null to one Studio owns", async () => {
    const synced = await linkedCard("9100", "todo");
    const own = await taskBoard.create({
      organizationId: ORG_R,
      title: "written in Studio",
      status: "todo",
      by: USER_R,
    });

    expect((await taskBoard.getById(synced.id, ORG_R))?.jiraIssueKey).toBe(
      "OS-9100",
    );
    expect((await taskBoard.getById(own.id, ORG_R))?.jiraIssueKey).toBe(null);

    const listed = await taskBoard.list(ORG_R);
    const byId = new Map(listed.map((i) => [i.id, i.jiraIssueKey]));
    expect(byId.get(synced.id)).toBe("OS-9100");
    expect(byId.get(own.id)).toBe(null);
  });

  it("leaves a fresh create's key null, before any link exists", async () => {
    const created = await taskBoard.create({
      organizationId: ORG_R,
      title: "fresh",
      status: "todo",
      by: USER_R,
    });
    expect(created.jiraIssueKey).toBe(null);
  });
});
