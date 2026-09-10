/**
 * The Jira integration as a run trigger, end to end over HTTP.
 *
 * An issue entering a Jira status that has a rule starts an agent run on that
 * issue. Studio keeps no copy of the issue: the run hangs off a hidden anchor
 * item, and the agent works the issue through the Jira tools its run is served.
 *
 * The tenant's Jira is a local stub (`fixtures/jira-stub.ts`), pointed at by
 * the integration's `siteUrl`; every other part of the path is the real one —
 * the credential check, the board read, the webhook route, the dispatch fence.
 *
 * What this cannot cover here: the agent run itself needs a model provider, so
 * the dispatch is asserted by its OUTCOME on the anchor (see the un-delegate
 * test) rather than by a completed run.
 */

import { expect, test } from "../fixtures/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { connectDevDb } from "../fixtures/db";
import type { APIRequestContext } from "@playwright/test";
import type { Client } from "pg";

const JIRA_STUB_ORIGIN = `http://localhost:${process.env.JIRA_STUB_PORT ?? "4103"}`;

// The stub's fixture data, inlined: a black-box test owns the shapes it asserts.
const BOARD_ID = "1610";
const ISSUE_ID = "10001";
const ISSUE_KEY = "EX-1";
const ISSUE_SUMMARY = "Make the checkout button blue";
/** The status inside the "Em Progresso" column — a Jira column is a bucket of
 *  statuses, and a rule is keyed by the STATUS the webhook reports. */
const AUTOMATED_STATUS = "Fazendo";

interface Integration {
  id: string;
  webhookSecret: string;
  boardId: string | null;
  enabled: boolean;
}

/** A `jira:issue_updated` payload, as Jira sends one. */
function statusChange(changelogId: string, toStatus = AUTOMATED_STATUS) {
  return {
    webhookEvent: "jira:issue_updated",
    issue: { id: ISSUE_ID, key: ISSUE_KEY },
    changelog: {
      id: changelogId,
      items: [
        { field: "assignee", toString: "Ana" },
        { field: "status", fromString: "Backlog", toString: toStatus },
      ],
    },
  };
}

async function connectIntegration(
  api: APIRequestContext,
  orgSlug: string,
): Promise<Integration> {
  const { integration } = await callSelfMcpTool<{ integration: Integration }>(
    api,
    orgSlug,
    "JIRA_INTEGRATION_UPSERT",
    {
      siteUrl: JIRA_STUB_ORIGIN,
      email: "bot@example.test",
      apiToken: "stub-token",
      boardId: BOARD_ID,
      boardName: "DECO",
      enabled: true,
    },
  );
  return integration;
}

test.describe("Jira run trigger", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db.end();
  });

  /** Every DB assertion is scoped to the test's own org. */
  const orgIdOf = async (orgSlug: string): Promise<string> => {
    const { rows } = await db.query<{ id: string }>(
      "select id from organization where slug = $1",
      [orgSlug],
    );
    expect(rows).toHaveLength(1);
    return rows[0].id;
  };

  test("connects to the site, and reads its board's columns by status", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    const integration = await connectIntegration(api, orgSlug);
    expect(integration.enabled).toBe(true);
    expect(integration.boardId).toBe(BOARD_ID);
    // The secret is the webhook's whole authentication, so it has to come back.
    expect(integration.webhookSecret).toBeTruthy();

    const { boards } = await callSelfMcpTool<{
      boards: Array<{ id: number; name: string }>;
    }>(api, orgSlug, "JIRA_BOARDS_LIST", {});
    expect(boards.map((b) => b.name)).toContain("DECO");

    const { columns } = await callSelfMcpTool<{
      columns: Array<{ name: string; statuses: string[] }>;
    }>(api, orgSlug, "JIRA_BOARD_COLUMNS_LIST", { boardId: BOARD_ID });
    // Column name and status name differ, which is why rules key on the status.
    expect(columns).toContainEqual({
      name: "Em Progresso",
      statuses: [AUTOMATED_STATUS],
    });
  });

  test("a rule exists only while its row does", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    await connectIntegration(api, orgSlug);
    const list = () =>
      callSelfMcpTool<{
        automations: Array<{ jiraStatus: string; prompt: string | null }>;
      }>(api, orgSlug, "JIRA_AUTOMATION_LIST", {});

    expect((await list()).automations).toEqual([]);
    await callSelfMcpTool(api, orgSlug, "JIRA_AUTOMATION_UPSERT", {
      jiraStatus: AUTOMATED_STATUS,
    });
    expect((await list()).automations).toEqual([
      { jiraStatus: AUTOMATED_STATUS, prompt: null },
    ]);

    await callSelfMcpTool(api, orgSlug, "JIRA_AUTOMATION_UPSERT", {
      jiraStatus: AUTOMATED_STATUS,
      prompt: "Implement it and open a pull request.",
    });
    expect((await list()).automations[0].prompt).toBe(
      "Implement it and open a pull request.",
    );

    const { removed } = await callSelfMcpTool<{ removed: boolean }>(
      api,
      orgSlug,
      "JIRA_AUTOMATION_DELETE",
      { jiraStatus: AUTOMATED_STATUS },
    );
    expect(removed).toBe(true);
    expect((await list()).automations).toEqual([]);
  });

  test("an issue entering an automated status is claimed exactly once", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const orgId = await orgIdOf(orgSlug);

    const integration = await connectIntegration(api, orgSlug);
    await callSelfMcpTool(api, orgSlug, "JIRA_AUTOMATION_UPSERT", {
      jiraStatus: AUTOMATED_STATUS,
      prompt: "Implement it and open a pull request.",
    });

    const hook = (payload: unknown) =>
      api.post(`/api/_jira/webhook/${integration.webhookSecret}`, {
        data: payload,
      });

    // Answered before the work: Jira times a hook out in seconds.
    expect((await hook(statusChange("9001"))).status()).toBe(202);
    await expect
      .poll(async () => (await anchors(db, orgId)).length, { timeout: 20_000 })
      .toBe(1);

    // A redelivery of the SAME transition must not buy a second run.
    expect((await hook(statusChange("9001"))).status()).toBe(202);
    // An update that did not touch the status is not a transition at all.
    expect(
      (
        await hook({
          webhookEvent: "jira:issue_updated",
          issue: { id: ISSUE_ID, key: ISSUE_KEY },
          changelog: { id: "9002", items: [{ field: "summary" }] },
        })
      ).status(),
    ).toBe(202);
    // A status with no rule is uneventful.
    expect((await hook(statusChange("9003", "Teste"))).status()).toBe(202);
    await page.waitForTimeout(3_000);

    const [anchor] = await anchors(db, orgId);
    expect(anchor.title).toBe(`${ISSUE_KEY}: ${ISSUE_SUMMARY}`);
    // Read off the issue, so the trigger really went to the site.
    expect(anchor.external_url).toBe(`${JIRA_STUB_ORIGIN}/browse/${ISSUE_KEY}`);
    expect(anchor.external_key).toBe(ISSUE_KEY);

    const claims = await db.query(
      "select changelog_id from jira_trigger_claims where organization_id = $1",
      [orgId],
    );
    expect(claims.rows.map((r) => r.changelog_id)).toEqual(["9001"]);

    const links = await db.query(
      "select jira_issue_key from task_board_item_jira_links where organization_id = $1",
      [orgId],
    );
    expect(links.rows).toEqual([{ jira_issue_key: ISSUE_KEY }]);

    // The anchor carries a run; it is not work the board shows.
    const { items } = await callSelfMcpTool<{ items: Array<{ id: string }> }>(
      api,
      orgSlug,
      "TASK_BOARD_ITEM_LIST",
      {},
    );
    expect(items.map((i) => i.id)).not.toContain(anchor.id);

    // No model provider in this org, so the dispatch fails — and a failed
    // dispatch must leave the anchor unowned rather than assigned to an agent
    // that will never run.
    expect(anchor.assignee_id).toBeNull();
  });

  test("an unknown webhook secret is refused", async ({ authedPage }) => {
    const { page } = authedPage;
    const res = await page
      .context()
      .request.post("/api/_jira/webhook/not-a-real-secret", {
        data: statusChange("9100"),
      });
    expect(res.status()).toBe(404);
  });

  /** The download route's only authentication is the signed grant its tool
   *  mints, so anything else must fail closed. */
  test("the attachment route refuses a token it did not mint", async ({
    authedPage,
  }) => {
    const request = authedPage.page.context().request;
    for (const token of [
      "garbage",
      "abc.def",
      Buffer.from(
        JSON.stringify({
          organizationId: "org_someone_else",
          attachmentId: "77001",
          expiresAt: Date.now() + 60_000,
        }),
      ).toString("base64url") + ".forged",
    ]) {
      const res = await request.get(`/api/_jira/attachments/${token}`);
      expect(res.status()).toBe(404);
    }
  });
});

/** The org's Jira run anchors — hidden items, so they are read from the DB. */
async function anchors(
  db: Client,
  organizationId: string,
): Promise<
  Array<{
    id: string;
    title: string;
    assignee_id: string | null;
    external_key: string | null;
    external_url: string | null;
  }>
> {
  const { rows } = await db.query(
    "select id, title, assignee_id, external_key, external_url from task_board_items where organization_id = $1 and source = 'jira'",
    [organizationId],
  );
  return rows;
}
