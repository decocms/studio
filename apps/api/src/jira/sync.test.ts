import { describe, expect, it } from "bun:test";
import type { OrgJiraIntegration } from "@/storage/types";
import { buildJql, vanishedLinks } from "./sync";

/**
 * The pull's query. Worth pinning because it is the whole definition of which
 * of a customer's issues become cards: the previous version scoped by
 * `/board/{id}/issue`, which excluded the board's Backlog tab, so an issue
 * filed and left in the backlog never reached the board at all.
 */
const NOW = new Date("2026-03-02T12:00:00.000Z");

function integration(
  overrides: Partial<OrgJiraIntegration> = {},
): OrgJiraIntegration {
  return {
    id: "int-1",
    organizationId: "org-1",
    siteUrl: "https://acme.atlassian.net",
    email: "e@acme.com",
    apiToken: "tok",
    boardId: "1610",
    boardName: "Board",
    statusMapping: { triage: ["BACKLOG"] },
    autoDelegate: false,
    webhookSecret: "secret",
    enabled: true,
    lastSyncedAt: null,
    lastSyncError: null,
    createdBy: "user-1",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("buildJql", () => {
  it("wraps the board's scope so its own ORs can't widen the query", () => {
    // `a OR b AND issuetype IN …` would bind as `a OR (b AND …)`.
    expect(buildJql(integration(), "project = OS OR project = WEB", NOW)).toBe(
      "(project = OS OR project = WEB) AND issuetype IN standardIssueTypes() ORDER BY updated ASC",
    );
  });

  it("is the scope, the issue-type cut and the watermark — nothing else", () => {
    expect(
      buildJql(
        integration({ lastSyncedAt: "2026-03-02T11:00:00.000Z" }),
        "project = OS",
        NOW,
      ),
    ).toBe(
      "(project = OS) AND issuetype IN standardIssueTypes() AND updated >= -65m ORDER BY updated ASC",
    );
  });

  it("has no backlog clause at all — the backlog is in scope", () => {
    const jql = buildJql(integration(), "project = OS", NOW);
    expect(jql).not.toContain("sprint");
    expect(jql).not.toContain("Sprint");
  });

  it("orders by updated ascending, which is what the watermark relies on", () => {
    expect(buildJql(integration(), "project = OS", NOW)).toEndWith(
      "ORDER BY updated ASC",
    );
  });

  it("pulls everything on the first run, with no watermark clause", () => {
    expect(buildJql(integration(), "project = OS", NOW)).not.toContain(
      "updated >=",
    );
  });

  it("asks for the elapsed window plus the overlap, in minutes", () => {
    const jql = buildJql(
      integration({ lastSyncedAt: "2026-03-02T11:00:00.000Z" }),
      "project = OS",
      NOW,
    );
    // 60 minutes elapsed + 5 of overlap.
    expect(jql).toContain("updated >= -65m");
  });

  /** The watermark is Jira's `updated` on Jira's clock, so it can sit ahead of
   *  ours — and `updated >= --25m` is a JQL 400 on every tick until they meet. */
  it("clamps a watermark in the future to the overlap window", () => {
    expect(
      buildJql(
        integration({ lastSyncedAt: "2026-03-02T12:30:00.000Z" }),
        "project = OS",
        NOW,
      ),
    ).toContain("updated >= -5m");
  });
});

/**
 * The reconciliation's decision, which is the only place the sync acts on the
 * ABSENCE of data — on one real board, six cards pointed at issues that had
 * been deleted or archived in Jira days earlier and would have sat there
 * forever.
 */
describe("vanishedLinks", () => {
  const link = (jiraIssueId: string) => ({
    jiraIssueId,
    itemId: `i${jiraIssueId}`,
  });

  it("picks exactly the cards whose issue is no longer in scope", () => {
    expect(
      vanishedLinks(new Set(["1", "3"]), [link("1"), link("2"), link("3")]),
    ).toEqual([link("2")]);
  });

  it("takes nothing when every card is still in scope", () => {
    expect(vanishedLinks(new Set(["1", "2"]), [link("1"), link("2")])).toEqual(
      [],
    );
  });

  /** A filter matching nothing is indistinguishable from one that broke, a
   *  revoked permission, or a renamed project — so it archives nothing. */
  it("refuses to archive the whole board off an empty scope", () => {
    expect(vanishedLinks(new Set(), [link("1"), link("2")])).toEqual([]);
  });

  it("has nothing to do on a board with no linked cards", () => {
    expect(vanishedLinks(new Set(["1"]), [])).toEqual([]);
  });
});
