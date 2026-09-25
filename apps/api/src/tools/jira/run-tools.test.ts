import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { taskRunContextStore } from "@/tools/task-board/task-run-context";
import {
  JIRA_ISSUE_CREATE,
  JIRA_ISSUE_SEARCH,
  JIRA_ISSUE_TRANSITION,
} from "./run-tools";

type Handler = typeof JIRA_ISSUE_CREATE.handler;
type Ctx = Parameters<Handler>[1];
type Input = Parameters<Handler>[0];

const THREAD = "thrd_run";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/**
 * A stand-in Jira: routes by method and path, and records every call so a
 * test can tell what was written.
 */
function fakeJira(opts: {
  openIssues?: Array<{ key: string; summary: string }>;
  issues?: Record<string, { summary: string; linked?: string[] }>;
  /** Issues the board's filter matches, beyond the run's own. */
  onBoard?: string[];
  failLinkTo?: string;
}) {
  const calls: Call[] = [];
  const handle = (method: string, path: string, body: unknown): unknown => {
    if (path.startsWith("/rest/agile/1.0/board/42/configuration")) {
      return { filter: { id: "77" } };
    }
    if (path.startsWith("/rest/api/3/filter/77")) {
      return { jql: 'project = "EX" ORDER BY Rank ASC' };
    }
    const jql = path.startsWith("/rest/api/3/search/jql")
      ? (new URLSearchParams(path.split("?")[1]).get("jql") ?? "")
      : null;
    const byKey = jql?.match(/key = "([A-Z]+-\d+)"/);
    if (byKey?.[1]) {
      const onBoard = (opts.onBoard ?? []).includes(byKey[1]);
      return { issues: onBoard ? [{ id: byKey[1], key: byKey[1] }] : [] };
    }
    if (jql !== null) {
      return {
        issues: (opts.openIssues ?? []).map((i) => ({
          id: i.key,
          key: i.key,
          fields: {
            summary: i.summary,
            status: { name: "BACKLOG" },
            issuetype: { name: "Story" },
            updated: "2026-01-02T03:04:05.000+0000",
          },
        })),
      };
    }
    if (/\/createmeta\/EX\/issuetypes\?/.test(path)) {
      return {
        issueTypes: [
          { id: "1", name: "Task" },
          { id: "2", name: "Story" },
          { id: "9", name: "Subtask", subtask: true },
        ],
      };
    }
    if (/\/createmeta\/EX\/issuetypes\/1\?/.test(path)) {
      return { fields: [{ fieldId: "summary", name: "Summary" }] };
    }
    if (/\/createmeta\/EX\/issuetypes\/2\?/.test(path)) {
      return {
        fields: [
          { fieldId: "summary", name: "Summary" },
          {
            fieldId: "customfield_10016",
            name: "Story point estimate",
            schema: { custom: "com.pyxis.greenhopper.jira:jsw-story-points" },
          },
          {
            fieldId: "customfield_10020",
            name: "Sprint",
            schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" },
          },
        ],
      };
    }
    if (path.startsWith("/rest/agile/1.0/board/42/sprint")) {
      return { values: [{ id: 7, name: "Sprint 7" }] };
    }
    const transitions = path.match(
      /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/transitions$/,
    );
    if (transitions) {
      return method === "GET"
        ? { transitions: [{ id: "31", name: "Start", to: { name: "Doing" } }] }
        : undefined;
    }
    if (method === "POST" && path === "/rest/api/3/issue") {
      return { id: "1000", key: "EX-99" };
    }
    if (method === "POST" && path === "/rest/api/3/issueLink") {
      const inward = (body as { inwardIssue: { key: string } }).inwardIssue.key;
      if (inward === opts.failLinkTo) {
        return new Response("no permission", { status: 403 });
      }
      return undefined;
    }
    const issue = path.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\?fields=/);
    if (issue?.[1] && opts.issues?.[issue[1]]) {
      const known = opts.issues[issue[1]]!;
      return {
        id: issue[1],
        key: issue[1],
        fields: {
          summary: known.summary,
          status: { name: "BACKLOG" },
          description: null,
          issuelinks: (known.linked ?? []).map((key) => ({
            type: { name: "Relates" },
            inwardIssue: { key },
          })),
        },
      };
    }
    return new Response(`not stubbed: ${method} ${path}`, { status: 404 });
  };
  const fetchMock = mock(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const path = `${url.pathname}${url.search}`;
    calls.push({ method, path, body });
    const out = handle(method, path, body);
    if (out instanceof Response) return out;
    return new Response(out === undefined ? "" : JSON.stringify(out), {
      status: out === undefined ? 204 : 200,
    });
  });
  return { calls, fetchMock };
}

function makeCtx(metadata: Record<string, unknown>) {
  const recordJiraIssueCreated = mock(async () => []);
  const ctx = {
    organization: { id: "org_1" },
    access: { check: mock(async () => {}) },
    storage: {
      jiraIntegrations: {
        getByOrg: mock(async () => ({
          organizationId: "org_1",
          siteUrl: "https://acme.atlassian.net",
          email: "bot@acme.test",
          apiToken: "tok",
          boardId: "42",
        })),
      },
      threads: {
        get: mock(async () => ({ id: THREAD, metadata })),
        recordJiraIssueCreated,
      },
    },
  } as unknown as Ctx;
  return { ctx, recordJiraIssueCreated };
}

const RUN = { source: "jira", jira_issue_keys: ["EX-1", "EX-2"] };

const input = (over: Partial<Input> = {}): Input => ({
  summary: "RELEASE - 24/09",
  issueType: "story",
  relatesTo: [],
  sprint: "none",
  ...over,
});

const run = <T>(fn: () => Promise<T>) =>
  taskRunContextStore.run({ threadId: THREAD }, fn);

describe("JIRA_ISSUE_CREATE", () => {
  const originalFetch = globalThis.fetch;
  let jira: ReturnType<typeof fakeJira>;
  const useJira = (opts: Parameters<typeof fakeJira>[0]) => {
    jira = fakeJira(opts);
    globalThis.fetch = jira.fetchMock as unknown as typeof fetch;
  };
  const writes = () => jira.calls.filter((c) => c.method === "POST");

  beforeEach(() => useJira({}));
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates in the run's project, in the active sprint, and links the run's issues", async () => {
    const { ctx, recordJiraIssueCreated } = makeCtx(RUN);

    const out = await run(() =>
      JIRA_ISSUE_CREATE.handler(
        input({
          description: "Cards: **EX-1**, EX-2",
          relatesTo: ["ex-1", "EX-2"],
          sprint: "active",
          storyPoints: 0,
        }),
        ctx,
      ),
    );

    expect(out).toEqual({
      key: "EX-99",
      url: "https://acme.atlassian.net/browse/EX-99",
      created: true,
      linked: ["EX-1", "EX-2"],
      notLinked: [],
    });
    const create = writes().find((c) => c.path === "/rest/api/3/issue");
    if (!create) throw new Error("no issue was created");
    const { fields } = create.body as { fields: Record<string, unknown> };
    expect(fields.project).toEqual({ key: "EX" });
    expect(fields.issuetype).toEqual({ id: "2" });
    expect(fields.customfield_10016).toBe(0);
    expect(fields.customfield_10020).toBe(7);
    expect((fields.description as { type: string }).type).toBe("doc");
    expect(recordJiraIssueCreated).toHaveBeenCalledWith(THREAD, "EX-99");
    expect(
      writes()
        .filter((c) => c.path === "/rest/api/3/issueLink")
        .map((c) => c.body),
    ).toEqual([
      {
        type: { name: "Relates" },
        inwardIssue: { key: "EX-1" },
        outwardIssue: { key: "EX-99" },
      },
      {
        type: { name: "Relates" },
        inwardIssue: { key: "EX-2" },
        outwardIssue: { key: "EX-99" },
      },
    ]);
  });

  it("links a board issue the run was not dispatched on", async () => {
    useJira({ onBoard: ["EX-30"] });
    const { ctx } = makeCtx(RUN);

    const out = await run(() =>
      JIRA_ISSUE_CREATE.handler(input({ relatesTo: ["ex-30"] }), ctx),
    );

    expect(out.linked).toEqual(["EX-30"]);
  });

  it("refuses to link an issue off the board before writing anything", async () => {
    const { ctx, recordJiraIssueCreated } = makeCtx(RUN);

    await expect(
      run(() =>
        JIRA_ISSUE_CREATE.handler(input({ relatesTo: ["OTHER-3"] }), ctx),
      ),
    ).rejects.toThrow("OTHER-3 is not on the connected Jira board");
    expect(writes()).toEqual([]);
    expect(recordJiraIssueCreated).not.toHaveBeenCalled();
  });

  it("returns an open issue that already has the summary, and links only what is missing", async () => {
    useJira({
      openIssues: [{ key: "EX-50", summary: " release - 24/09 " }],
      issues: { "EX-50": { summary: "release - 24/09", linked: ["EX-1"] } },
    });
    const { ctx, recordJiraIssueCreated } = makeCtx(RUN);

    const out = await run(() =>
      JIRA_ISSUE_CREATE.handler(input({ relatesTo: ["EX-1", "EX-2"] }), ctx),
    );

    expect(out).toMatchObject({
      key: "EX-50",
      created: false,
      linked: ["EX-1", "EX-2"],
    });
    expect(writes().map((c) => c.path)).toEqual(["/rest/api/3/issueLink"]);
    const search = jira.calls.find((c) => c.path.includes("/search/jql"));
    const jql = new URLSearchParams(search?.path.split("?")[1]).get("jql");
    expect(jql).toContain("reporter = currentUser()");
    // Found, not created: it does not count against the cap.
    expect(recordJiraIssueCreated).not.toHaveBeenCalled();
  });

  it("finds its own earlier creation without relying on search", async () => {
    // A restarted run repeats itself; a fresh issue may not be searchable yet.
    useJira({ issues: { "EX-99": { summary: "RELEASE - 24/09" } } });
    const { ctx } = makeCtx({
      ...RUN,
      jira_issue_keys: ["EX-1", "EX-2", "EX-99"],
      jira_created_issue_keys: ["EX-99"],
    });

    const out = await run(() => JIRA_ISSUE_CREATE.handler(input(), ctx));

    expect(out).toMatchObject({ key: "EX-99", created: false });
    expect(writes()).toEqual([]);
  });

  it("falls through to search when a prior creation no longer reads", async () => {
    useJira({
      openIssues: [{ key: "EX-50", summary: "release - 24/09" }],
      issues: { "EX-50": { summary: "release - 24/09" } },
      // "EX-99" is not stubbed in `issues`, so getIssue 404s.
    });
    const { ctx } = makeCtx({
      ...RUN,
      jira_created_issue_keys: ["EX-99"],
    });

    const out = await run(() => JIRA_ISSUE_CREATE.handler(input(), ctx));

    expect(out).toMatchObject({ key: "EX-50", created: false });
    expect(writes()).toEqual([]);
  });

  it("stops creating once the run has created five issues", async () => {
    const created = ["EX-10", "EX-11", "EX-12", "EX-13", "EX-14"];
    useJira({
      issues: Object.fromEntries(
        created.map((k) => [k, { summary: `other ${k}` }]),
      ),
    });
    const { ctx } = makeCtx({
      ...RUN,
      jira_created_issue_keys: created,
    });

    await expect(
      run(() => JIRA_ISSUE_CREATE.handler(input(), ctx)),
    ).rejects.toThrow("the most one run may");
    expect(writes()).toEqual([]);
  });

  it("reports a failed link and keeps the created issue reachable", async () => {
    useJira({ failLinkTo: "EX-2" });
    const { ctx, recordJiraIssueCreated } = makeCtx(RUN);

    const out = await run(() =>
      JIRA_ISSUE_CREATE.handler(input({ relatesTo: ["EX-1", "EX-2"] }), ctx),
    );

    expect(out.linked).toEqual(["EX-1"]);
    expect(out.notLinked).toEqual([
      { key: "EX-2", reason: expect.stringContaining("403") },
    ]);
    expect(recordJiraIssueCreated).toHaveBeenCalledWith(THREAD, "EX-99");
  });

  it("names the project's issue types when the requested one does not exist", async () => {
    const { ctx } = makeCtx(RUN);

    await expect(
      run(() =>
        JIRA_ISSUE_CREATE.handler(input({ issueType: "História" }), ctx),
      ),
    ).rejects.toThrow('EX has no issue type "História" — it has: Task, Story');
  });

  it("refuses a story points value the issue type has no field for", async () => {
    const { ctx } = makeCtx(RUN);

    await expect(
      run(() =>
        JIRA_ISSUE_CREATE.handler(
          input({ issueType: "Task", storyPoints: 3 }),
          ctx,
        ),
      ),
    ).rejects.toThrow("no story points field");
    expect(writes()).toEqual([]);
  });

  it("refuses a run whose issues span several projects", async () => {
    const { ctx } = makeCtx({
      source: "jira",
      jira_issue_keys: ["EX-1", "OPS-2"],
    });

    await expect(
      run(() => JIRA_ISSUE_CREATE.handler(input(), ctx)),
    ).rejects.toThrow("single project");
  });
});

describe("the board boundary on the other run tools", () => {
  const originalFetch = globalThis.fetch;
  let jira: ReturnType<typeof fakeJira>;
  const useJira = (opts: Parameters<typeof fakeJira>[0]) => {
    jira = fakeJira(opts);
    globalThis.fetch = jira.fetchMock as unknown as typeof fetch;
  };
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("moves an issue on the board that the run was not dispatched on", async () => {
    useJira({ onBoard: ["EX-30"] });
    const { ctx } = makeCtx(RUN);

    const out = await run(() =>
      JIRA_ISSUE_TRANSITION.handler(
        { issueKey: "EX-30", toStatus: "doing" },
        ctx,
      ),
    );

    expect(out).toEqual({ status: "Doing" });
  });

  it("does not touch an issue elsewhere on the Jira site", async () => {
    useJira({});
    const { ctx } = makeCtx(RUN);

    await expect(
      run(() =>
        JIRA_ISSUE_TRANSITION.handler(
          { issueKey: "HR-4", toStatus: "Doing" },
          ctx,
        ),
      ),
    ).rejects.toThrow("HR-4 is not on the connected Jira board");
    expect(jira.calls.some((c) => c.path.includes("/transitions"))).toBe(false);
  });

  it("skips the board check for the run's own issue", async () => {
    useJira({});
    const { ctx } = makeCtx(RUN);

    await run(() =>
      JIRA_ISSUE_TRANSITION.handler(
        { issueKey: "ex-1", toStatus: "Doing" },
        ctx,
      ),
    );

    expect(jira.calls.some((c) => c.path.includes("/search/jql"))).toBe(false);
  });
});

describe("JIRA_ISSUE_SEARCH", () => {
  const originalFetch = globalThis.fetch;
  let jira: ReturnType<typeof fakeJira>;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("narrows the query to the board and keeps its ordering", async () => {
    jira = fakeJira({
      openIssues: [
        { key: "EX-5", summary: "one" },
        { key: "EX-6", summary: "two" },
      ],
    });
    globalThis.fetch = jira.fetchMock as unknown as typeof fetch;
    const { ctx } = makeCtx(RUN);

    const out = await JIRA_ISSUE_SEARCH.handler(
      { jql: 'status = "Code Review" ORDER BY updated DESC', limit: 1 },
      ctx,
    );

    const search = jira.calls.find((c) => c.path.includes("/search/jql"));
    expect(new URLSearchParams(search?.path.split("?")[1]).get("jql")).toBe(
      '(project = "EX") AND (status = "Code Review") ORDER BY updated DESC',
    );
    expect(out).toEqual({
      issues: [
        {
          key: "EX-5",
          url: "https://acme.atlassian.net/browse/EX-5",
          summary: "one",
          status: "BACKLOG",
          type: "Story",
          updated: "2026-01-02T03:04:05.000+0000",
        },
      ],
      truncated: true,
    });
  });
});
