import { describe, expect, it } from "bun:test";
import type { OrgJiraIntegration } from "@/storage/types";
import {
  buildJql,
  isUnchanged,
  rescanContinues,
  rewritesSprint,
  rewritesStatus,
  runTruncated,
  triggersColumnAutomation,
  vanishedLinks,
} from "./sync";

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
    rescanPending: false,
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

/**
 * The "nothing to do" shortcut. It fires BEFORE any field is written, which is
 * why a rescan must not take it: migration 184 cleared the watermark to re-read
 * a widened scope, and the run created the 50 cards it was missing while
 * leaving 274 existing ones with the `sprint_id` they never had — 253 issues
 * that Jira has in a sprint read as backlog on the board.
 */
describe("isUnchanged", () => {
  const seen = "2026-03-02T12:00:00.000Z";

  it("skips an issue no newer than what the link recorded", () => {
    expect(isUnchanged(seen, new Date(seen), false)).toBe(true);
    expect(isUnchanged(seen, new Date("2026-03-02T11:00:00.000Z"), false)).toBe(
      true,
    );
  });

  it("processes an issue that moved on", () => {
    expect(isUnchanged(seen, new Date("2026-03-02T12:00:01.000Z"), false)).toBe(
      false,
    );
  });

  it("never skips on a rescan, however old the issue looks", () => {
    expect(isUnchanged(seen, new Date(seen), true)).toBe(false);
    expect(isUnchanged(seen, new Date("2020-01-01T00:00:00.000Z"), true)).toBe(
      false,
    );
  });
});

/**
 * A rescan run only advances as far as its per-run caps allow. If the flag
 * that forces the rescan doesn't survive a truncated run, the NEXT run reads
 * a non-null watermark, stops treating itself as a rescan, and silently skips
 * every issue past the cap as "unchanged" — the exact bug 185 fixed, just
 * past 500 issues instead of at the watermark.
 */
describe("rescanContinues", () => {
  it("keeps forcing a rescan when a run hit the issue cap", () => {
    expect(rescanContinues(true, 500, 3)).toBe(true);
  });

  it("keeps forcing a rescan when a run hit the page cap", () => {
    expect(rescanContinues(true, 10, 25)).toBe(true);
  });

  it("clears once a rescan run finishes the scope under both caps", () => {
    expect(rescanContinues(true, 42, 1)).toBe(false);
  });

  it("never claims a rescan for a plain incremental run", () => {
    expect(rescanContinues(false, 500, 25)).toBe(false);
  });
});

/**
 * `reconcileVanishedIssues` (which archives cards outside Jira's live scope)
 * gates on this same truncation check — a run that hit the PAGE cap on many
 * empty-but-tokened pages, with `processed` still low, is just as incomplete
 * as one that hit the issue cap, and must not be read as "finished".
 */
describe("runTruncated", () => {
  it("is truncated once the issue cap is hit", () => {
    expect(runTruncated(500, 3)).toBe(true);
  });

  it("is truncated once the page cap is hit, even with few issues processed", () => {
    expect(runTruncated(10, 25)).toBe(true);
  });

  it("is not truncated when a run finishes under both caps", () => {
    expect(runTruncated(42, 1)).toBe(false);
  });
});

/**
 * The rule that makes a board conversion survivable.
 *
 * Normally the pull leaves a card's status alone unless Jira's own changed —
 * that is what stops an unrelated edit yanking back a card the agent
 * advanced. But on the day an org's board becomes its own, every card is
 * holding one of Studio's lanes while the columns are suddenly the tracker's,
 * and a card nobody touched in Jira would render nowhere at all.
 */
describe("rewritesSprint", () => {
  const rewrites = (
    lastSeenJiraSprintId: string | null,
    jiraSprintId: string | null,
  ) => rewritesSprint({ lastSeenJiraSprintId, jiraSprintId });

  it("writes when Jira moved the issue to another sprint", () => {
    expect(rewrites("41", "42")).toBe(true);
  });

  it("writes when Jira moved the issue out of every sprint", () => {
    expect(rewrites("42", null)).toBe(true);
  });

  it("writes when Jira pulled a backlog issue into a sprint", () => {
    expect(rewrites(null, "42")).toBe(true);
  });

  /**
   * The whole point. Someone pulls a card into the sprint in Studio, the push
   * records its target on the link, and the next tick reads Jira agreeing.
   * Writing here would be a no-op at best; before the push lands it would undo
   * the person who moved the card.
   */
  it("leaves the card alone when Jira agrees with what we last set", () => {
    expect(rewrites("42", "42")).toBe(false);
    expect(rewrites(null, null)).toBe(false);
  });
});

describe("rewritesStatus", () => {
  const columns = new Set(["BACKLOG", "Fazendo", "Code Review"]);

  it("writes when Jira moved the issue", () => {
    expect(
      rewritesStatus({
        jiraStatusChanged: true,
        currentStatus: "Fazendo",
        boardColumns: columns,
      }),
    ).toBe(true);
  });

  it("leaves a card alone when Jira did not move it", () => {
    expect(
      rewritesStatus({
        jiraStatusChanged: false,
        currentStatus: "Fazendo",
        boardColumns: columns,
      }),
    ).toBe(false);
  });

  it("re-homes a card stranded in a column the board does not have", () => {
    expect(
      rewritesStatus({
        jiraStatusChanged: false,
        currentStatus: "triage",
        boardColumns: columns,
      }),
    ).toBe(true);
  });

  /** The bound that makes this a conversion path and not a standing override:
   *  a re-homed card stops being re-written on the very next pull. */
  it("stops re-homing once the card lands somewhere real", () => {
    expect(
      rewritesStatus({
        jiraStatusChanged: false,
        currentStatus: "BACKLOG",
        boardColumns: columns,
      }),
    ).toBe(false);
  });

  it("has nothing to re-home when the card could not be read", () => {
    expect(
      rewritesStatus({
        jiraStatusChanged: false,
        currentStatus: null,
        boardColumns: columns,
      }),
    ).toBe(false);
  });

  /** Studio's own board answers with its nine lanes, so no card on it is ever
   *  stranded and this rule changes nothing there. */
  it("never re-homes on a board whose columns are Studio's own", () => {
    const canonical = new Set(["triage", "todo", "in_progress", "done"]);
    for (const status of canonical) {
      expect(
        rewritesStatus({
          jiraStatusChanged: false,
          currentStatus: status,
          boardColumns: canonical,
        }),
      ).toBe(false);
    }
  });
});

describe("triggersColumnAutomation", () => {
  it("fires when the issue's board column actually changed", () => {
    expect(
      triggersColumnAutomation({
        previousStatus: "BACKLOG",
        newStatus: "In Progress",
        isRescan: false,
      }),
    ).toBe(true);
  });

  /** Two Jira statuses ("In Review (Dev)", "In Review (QA)") can map to the
   *  same board column — the card never left it, so its rule must not refire. */
  it("does not fire when two Jira statuses map onto the same board column", () => {
    expect(
      triggersColumnAutomation({
        previousStatus: "In Review",
        newStatus: "In Review",
        isRescan: false,
      }),
    ).toBe(false);
  });

  it("never fires on a rescan, however the column reads", () => {
    expect(
      triggersColumnAutomation({
        previousStatus: "BACKLOG",
        newStatus: "In Progress",
        isRescan: true,
      }),
    ).toBe(false);
  });
});
