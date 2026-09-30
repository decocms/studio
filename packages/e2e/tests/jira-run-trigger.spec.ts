/**
 * The Jira integration as a run trigger, end to end over HTTP.
 *
 * An issue that enters a Jira status with a rule, and stays there, starts an
 * agent run on that issue. Studio keeps no copy of the issue: the run hangs off a hidden anchor
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

/** Longer than the server's `JIRA_SETTLE_SECONDS` plus its clock-skew margin:
 *  by then any rule the moves could start has started. */
const SETTLED_MS = 10_000;

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

/** Jira records a move before it sends the webhook; the stub has to know it,
 *  because the trigger reads the issue's history back once the card settles. */
async function moveInJira(
  api: APIRequestContext,
  changelogId: string,
  to: string,
  at = Date.now(),
): Promise<void> {
  const res = await api.post(`${JIRA_STUB_ORIGIN}/__move`, {
    data: { changelogId, to, at },
  });
  expect(res.ok()).toBe(true);
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
        automations: Array<{
          jiraStatus: string;
          from: { kind: string; statuses?: string[] };
          prompt: string | null;
          continuePr: boolean;
        }>;
      }>(api, orgSlug, "JIRA_AUTOMATION_LIST", {});

    expect((await list()).automations).toEqual([]);
    await callSelfMcpTool(api, orgSlug, "JIRA_AUTOMATION_UPSERT", {
      jiraStatus: AUTOMATED_STATUS,
    });
    expect((await list()).automations).toEqual([
      {
        jiraStatus: AUTOMATED_STATUS,
        from: { kind: "any" },
        prompt: null,
        continuePr: false,
      },
    ]);

    await callSelfMcpTool(api, orgSlug, "JIRA_AUTOMATION_UPSERT", {
      jiraStatus: AUTOMATED_STATUS,
      prompt: "Implement it and open a pull request.",
      continuePr: true,
    });
    expect((await list()).automations).toEqual([
      {
        jiraStatus: AUTOMATED_STATUS,
        from: { kind: "any" },
        prompt: "Implement it and open a pull request.",
        continuePr: true,
      },
    ]);

    await callSelfMcpTool(api, orgSlug, "JIRA_AUTOMATION_UPSERT", {
      jiraStatus: AUTOMATED_STATUS,
      continuePr: false,
    });
    expect((await list()).automations).toEqual([
      {
        jiraStatus: AUTOMATED_STATUS,
        from: { kind: "any" },
        prompt: null,
        continuePr: false,
      },
    ]);

    // A second rule on the same status, for cards sent back to it.
    await callSelfMcpTool(api, orgSlug, "JIRA_AUTOMATION_UPSERT", {
      jiraStatus: AUTOMATED_STATUS,
      from: { kind: "later" },
      prompt: "Read why it came back and fix it.",
      continuePr: true,
    });
    expect((await list()).automations.map((a) => a.from)).toEqual([
      { kind: "any" },
      { kind: "later" },
    ]);

    // Two lists on one status may not both claim the same origin.
    await callSelfMcpTool(api, orgSlug, "JIRA_AUTOMATION_UPSERT", {
      jiraStatus: AUTOMATED_STATUS,
      from: { kind: "statuses", statuses: ["Teste"] },
    });
    await expect(
      callSelfMcpTool(api, orgSlug, "JIRA_AUTOMATION_UPSERT", {
        jiraStatus: AUTOMATED_STATUS,
        from: { kind: "statuses", statuses: ["Code Review", "teste"] },
      }),
    ).rejects.toThrow(/already answers moves from "teste"/);

    for (const from of [
      { kind: "any" },
      { kind: "later" },
      { kind: "statuses", statuses: ["Teste"] },
    ]) {
      const { removed } = await callSelfMcpTool<{ removed: boolean }>(
        api,
        orgSlug,
        "JIRA_AUTOMATION_DELETE",
        { jiraStatus: AUTOMATED_STATUS, from },
      );
      expect(removed).toBe(true);
    }
    expect((await list()).automations).toEqual([]);
  });

  test("a rule answers only the origin it names", async ({ authedPage }) => {
    // Two settle windows, each waited out.
    test.setTimeout(90_000);
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const orgId = await orgIdOf(orgSlug);

    const integration = await connectIntegration(api, orgSlug);
    // Only cards arriving from an earlier column: a first implementation.
    await callSelfMcpTool(api, orgSlug, "JIRA_AUTOMATION_UPSERT", {
      jiraStatus: AUTOMATED_STATUS,
      from: { kind: "earlier" },
      prompt: "Implement it and open a pull request.",
    });
    const hook = (payload: unknown) =>
      api.post(`/api/_jira/webhook/${integration.webhookSecret}`, {
        data: payload,
      });
    const claimed = async () =>
      (
        await db.query(
          "select changelog_id from jira_trigger_claims where organization_id = $1 order by changelog_id",
          [orgId],
        )
      ).rows.map((r) => r.changelog_id);

    expect((await api.post(`${JIRA_STUB_ORIGIN}/__reset`)).ok()).toBe(true);
    // Sent back from review, which is right of it on the board: not this rule.
    await moveInJira(api, "9301", "Code Review", Date.now() - 10 * 60_000);
    await moveInJira(api, "9302", AUTOMATED_STATUS);
    expect((await hook(statusChange("9302"))).status()).toBe(202);
    await page.waitForTimeout(SETTLED_MS);
    expect(await claimed()).toEqual([]);

    // Out of the backlog, left of it: this rule. The card has to rest there
    // first, or it merely passed through on its way back.
    await moveInJira(api, "9303", "Backlog");
    await page.waitForTimeout(3_000);
    await moveInJira(api, "9304", AUTOMATED_STATUS);
    expect((await hook(statusChange("9304"))).status()).toBe(202);
    await expect.poll(claimed, { timeout: 30_000 }).toEqual(["9304"]);
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

    expect((await api.post(`${JIRA_STUB_ORIGIN}/__reset`)).ok()).toBe(true);
    await moveInJira(api, "9001", AUTOMATED_STATUS);
    // Answered before the work: Jira times a hook out in seconds. The run
    // starts once the card has stayed put for the settle window.
    expect((await hook(statusChange("9001"))).status()).toBe(202);
    await expect
      .poll(async () => (await anchors(db, orgId)).length, { timeout: 30_000 })
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
    await moveInJira(api, "9003", "Teste");
    expect((await hook(statusChange("9003", "Teste"))).status()).toBe(202);
    await page.waitForTimeout(SETTLED_MS);

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

  test("a card dropped in a column and straight back starts nothing", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const orgId = await orgIdOf(orgSlug);

    const integration = await connectIntegration(api, orgSlug);
    for (const jiraStatus of [AUTOMATED_STATUS, "Code Review"]) {
      await callSelfMcpTool(api, orgSlug, "JIRA_AUTOMATION_UPSERT", {
        jiraStatus,
        prompt: `Work the card in ${jiraStatus}.`,
      });
    }
    const hook = (payload: unknown) =>
      api.post(`/api/_jira/webhook/${integration.webhookSecret}`, {
        data: payload,
      });

    expect((await api.post(`${JIRA_STUB_ORIGIN}/__reset`)).ok()).toBe(true);
    // The card has long been in the implementing column…
    await moveInJira(api, "9201", AUTOMATED_STATUS, Date.now() - 10 * 60_000);
    // …when someone drops it in review by mistake and drags it straight back.
    await moveInJira(api, "9202", "Code Review");
    expect((await hook(statusChange("9202", "Code Review"))).status()).toBe(
      202,
    );
    await moveInJira(api, "9203", AUTOMATED_STATUS);
    expect((await hook(statusChange("9203"))).status()).toBe(202);
    await page.waitForTimeout(SETTLED_MS);

    // The drop was superseded, and the card went back where it rested: no
    // run in either column, so nothing superseded the one it was waiting on.
    const claims = await db.query(
      "select changelog_id from jira_trigger_claims where organization_id = $1",
      [orgId],
    );
    expect(claims.rows).toEqual([]);
    expect(await anchors(db, orgId)).toEqual([]);
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
