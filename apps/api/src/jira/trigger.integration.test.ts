/**
 * Real-Postgres coverage for what the Jira trigger leans on in storage.
 *
 * The fence is the point: the webhook, its redelivery and the safety-net poll
 * can all report the same transition, and exactly one of them may fire it. That is a conditional insert on a real unique key, which no
 * in-memory fake can be trusted to model.
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
import { createAutomationsStorage } from "../storage/automations";
import { JiraIntegrationStorage } from "../storage/jira-integrations";
import { TaskBoardStorage } from "../storage/task-board";

const ORG = "org_jira_trigger";
const USER = "user_jira_trigger";

describe("Jira trigger storage (real Postgres)", () => {
  let database: StudioDatabase;
  let jira: JiraIntegrationStorage;
  let taskBoard: TaskBoardStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({ id: ORG, name: ORG, slug: "org-jira-trigger", createdAt: now })
      .execute();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, ${"jira-trigger@test"}, false, ${USER}, ${now}, ${now})
    `.execute(database.db);
    jira = new JiraIntegrationStorage(
      database.db,
      new CredentialVault("0".repeat(64)),
    );
    taskBoard = new TaskBoardStorage(database.db);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("lets exactly one of several claimers win a transition", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => jira.claimTrigger(ORG, "10001", "5001")),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    // The same issue entering the column again is a NEW transition.
    expect(await jira.claimTrigger(ORG, "10001", "5002")).toBe(true);
  });

  it("keeps one anchor per issue, whoever asks first", async () => {
    const a = await taskBoard.create({
      organizationId: ORG,
      title: "EX-1: first",
      source: "jira",
      by: USER,
    });
    const b = await taskBoard.create({
      organizationId: ORG,
      title: "EX-1: second",
      source: "jira",
      by: USER,
    });
    await jira.createLink({
      itemId: a.id,
      organizationId: ORG,
      jiraIssueId: "20001",
      jiraIssueKey: "EX-1",
    });
    // A racing second link changes nothing rather than throwing.
    await jira.createLink({
      itemId: b.id,
      organizationId: ORG,
      jiraIssueId: "20001",
      jiraIssueKey: "EX-1",
    });
    expect((await jira.getLinkByIssueId(ORG, "20001"))?.itemId).toBe(a.id);
    expect((await jira.getLinkByItemId(a.id, ORG))?.jiraIssueKey).toBe("EX-1");
    expect(await jira.getLinkByItemId(b.id, ORG)).toBeNull();
  });

  /** The anchor is a run's, not the board's: it must never show up as a card. */
  it("hides a Jira run's anchor from the board list, but not from getById", async () => {
    const anchor = await taskBoard.create({
      organizationId: ORG,
      title: "EX-2: anchor",
      source: "jira",
      by: USER,
    });
    const card = await taskBoard.create({
      organizationId: ORG,
      title: "a real card",
      by: USER,
    });
    const listed = (await taskBoard.list(ORG)).map((i) => i.id);
    expect(listed).toContain(card.id);
    expect(listed).not.toContain(anchor.id);
    expect((await taskBoard.getById(anchor.id, ORG))?.source).toBe("jira");
    expect(card.source).toBeNull();
  });

  it("lists an org's Jira triggers by status, and only its own", async () => {
    const automations = createAutomationsStorage(database.db);
    const make = async (name: string, status: string, active = true) => {
      const automation = await automations.create({
        organization_id: ORG,
        name,
        active,
        created_by: USER,
        messages: "[]",
        models: "{}",
        virtual_mcp_id: `decopilot_${ORG}`,
      });
      await automations.addTrigger({
        automation_id: automation.id,
        type: "jira_transition",
        column_key: status,
        from_kind: "statuses",
        from_statuses: ["Backlog", "Client QA"],
      });
      return automation;
    };
    const doing = await make("doing", "Doing");
    await make("review", "Code Review");
    const paused = await make("paused", "Doing", false);

    const onDoing = await automations.listJiraTransitionTriggers(ORG, {
      jiraStatus: "Doing",
    });
    expect(onDoing.map((t) => t.automation.name)).toEqual(["doing", "paused"]);
    expect(onDoing[0]?.from_statuses).toEqual(["Backlog", "Client QA"]);
    expect(
      (
        await automations.listJiraTransitionTriggers(ORG, {
          jiraStatus: "Doing",
          activeOnly: true,
        })
      ).map((t) => t.automation_id),
    ).toEqual([doing.id]);
    expect(await automations.listJiraTransitionTriggers(ORG)).toHaveLength(3);
    expect(await automations.listJiraTransitionTriggers("org_other")).toEqual(
      [],
    );
    // A board trigger on a column named like a status is not a Jira trigger.
    await automations.addTrigger({
      automation_id: paused.id,
      type: "board_column_transition",
      column_key: "Doing",
      from_kind: "any",
    });
    expect(
      await automations.listJiraTransitionTriggers(ORG, {
        jiraStatus: "Doing",
      }),
    ).toHaveLength(2);
  });
});
