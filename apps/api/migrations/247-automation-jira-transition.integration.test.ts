import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql, type Kysely } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../src/database/test-db-pg";
import type { StudioDatabase } from "../src/database";
import { up } from "./247-automation-jira-transition";

let database: StudioDatabase;
beforeAll(async () => {
  database = await connectTestPgDatabase();
  await seedCommonTestPgFixtures(database);
});
afterAll(async () => {
  await closeTestPgDatabase(database);
});

test("copies each Jira status rule into an automation with a jira_transition trigger, once", async () => {
  const transaction = await database.db.startTransaction().execute();
  try {
    await sql`INSERT INTO org_jira_integrations (organization_id, site_url, email, api_token, created_by)
      VALUES ('org_1', 'https://example.atlassian.net', 'bot@example.test', 'x', 'user_1')
    `.execute(transaction);
    await sql`INSERT INTO org_jira_column_automations (organization_id, jira_status, prompt, continue_pr, from_kind, from_statuses, from_key)
      VALUES
      ('org_1', 'Doing', ${"Implement it.\n\n# Then\nOpen a pull request."}, true, 'any', '{}', 'any'),
      ('org_1', 'Doing', null, false, 'statuses', '{Backlog,Client QA}', ${"statuses:backlog\nclient qa"}),
      ('org_123', 'Doing', 'No integration, no creator.', false, 'any', '{}', 'any')
    `.execute(transaction);

    const migrationDb = transaction as unknown as Kysely<unknown>;
    await up(migrationDb);
    await up(migrationDb);

    const { rows } = await sql<{
      name: string;
      active: boolean;
      created_by: string;
      virtual_mcp_id: string;
      messages: string;
      type: string;
      column_key: string;
      from_kind: string;
      from_statuses: string[];
    }>`
      SELECT a.name, a.active, a.created_by, a.virtual_mcp_id, a.messages,
             t.type, t.column_key, t.from_kind, t.from_statuses
        FROM automations a JOIN automation_triggers t ON t.automation_id = a.id
       WHERE a.id LIKE 'auto_jira_%'
       ORDER BY a.name
    `.execute(transaction);
    expect(rows.map(({ messages: _, ...row }) => row)).toEqual([
      {
        name: "Jira: Doing",
        active: true,
        created_by: "user_1",
        virtual_mcp_id: "decopilot_org_1",
        type: "jira_transition",
        column_key: "Doing",
        from_kind: "any",
        from_statuses: [],
      },
      {
        name: "Jira: Doing (from Backlog, Client QA)",
        active: true,
        created_by: "user_1",
        virtual_mcp_id: "decopilot_org_1",
        type: "jira_transition",
        column_key: "Doing",
        from_kind: "statuses",
        from_statuses: ["Backlog", "Client QA"],
      },
    ]);

    const [withPrompt, withoutPrompt] = rows;
    expect(JSON.parse(withoutPrompt!.messages)).toEqual([]);
    const [message] = JSON.parse(withPrompt!.messages);
    expect(message.parts).toEqual([
      { type: "text", text: "Implement it.\n\n# Then\nOpen a pull request." },
    ]);
    // The editor reads the doc, one paragraph per line, blank ones included.
    expect(message.metadata.tiptapDoc.content).toHaveLength(4);
    expect(message.metadata.tiptapDoc.content[1]).toEqual({
      type: "paragraph",
    });

    // The rules stay for the release that still reads them.
    const kept = await sql`SELECT 1 FROM org_jira_column_automations`.execute(
      transaction,
    );
    expect(kept.rows).toHaveLength(3);
  } finally {
    await transaction.rollback().execute();
  }
});
