import { describe, expect, it } from "bun:test";
import type { OrgJiraIntegration } from "@/storage/types";
import { buildJql } from "./sync";

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
    jqlFilter: null,
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

  it("ANDs the tenant's extra filter, parenthesized", () => {
    expect(
      buildJql(
        integration({ jqlFilter: "labels = web OR labels = seo" }),
        "project = OS",
        NOW,
      ),
    ).toContain("AND (labels = web OR labels = seo)");
  });

  it("ignores a whitespace-only extra filter instead of ANDing an empty group", () => {
    expect(
      buildJql(integration({ jqlFilter: "   " }), "project = OS", NOW),
    ).toBe(
      "(project = OS) AND issuetype IN standardIssueTypes() ORDER BY updated ASC",
    );
  });
});
