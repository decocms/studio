import { describe, expect, test } from "bun:test";
import {
  matchesTaskKey,
  resolveTaskBoardProjectAssignment,
  resolveTaskBoardProjectScope,
  taskMatchesFilters,
  taskMatchesProjectScope,
  EMPTY_FILTERS,
} from "./task-filters";
import { buildProjectIndex, NO_PROJECT_FILTER } from "@/lib/project-index";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import type { TaskBoardItem } from "./config";
import { getWellKnownDecopilotVirtualMCP } from "@decocms/shared/sdk";

const SITE = {
  id: "vir_site",
  title: "Acme Site",
  created_at: "2026-01-01T00:00:00Z",
  metadata: {
    githubRepo: {
      url: "https://github.com/acme/site",
      owner: "acme",
      name: "site",
    },
  },
} as unknown as VirtualMCPEntity;

/** Closed over every repo these tests name, the way the board's index is —
 *  see `useProjectIndex`. */
const INDEX = buildProjectIndex([SITE], ["acme/other"]);

const SIBLING = {
  ...SITE,
  id: "vir_sibling",
  title: "Acme Site sibling",
  created_at: "2026-01-02T00:00:00Z",
} as unknown as VirtualMCPEntity;

const SHARED_REPO_INDEX = buildProjectIndex([SITE, SIBLING]);

describe("resolveTaskBoardProjectAssignment", () => {
  const selected = {
    title: "Task",
    virtualMcpId: SIBLING.id,
    repo: "acme/site",
  };

  test("keeps an org-level editor's exact project assignment", () => {
    expect(resolveTaskBoardProjectAssignment(selected)).toBe(selected);
  });

  test("makes route ownership authoritative over stale editor values", () => {
    expect(
      resolveTaskBoardProjectAssignment(selected, {
        projectId: SITE.id,
        repo: "acme/canonical",
      }),
    ).toEqual({
      virtualMcpId: SITE.id,
      repo: "acme/canonical",
    });
  });

  test("clears a stale execution repo for a repository-less route project", () => {
    expect(
      resolveTaskBoardProjectAssignment(selected, {
        projectId: "vir_no_repo",
        repo: null,
      }),
    ).toEqual({
      virtualMcpId: "vir_no_repo",
      repo: null,
    });
  });
});

function item(overrides: Partial<TaskBoardItem> = {}): TaskBoardItem {
  return {
    id: "item-1",
    organizationId: "org-1",
    title: "Task",
    description: null,
    status: "todo",
    priority: "none",
    assigneeId: null,
    assignedBy: null,
    virtualMcpId: null,
    dueDate: null,
    threads: [],
    tags: [],
    createdBy: "user-1",
    createdAt: new Date().toISOString(),
    updatedBy: "user-1",
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as TaskBoardItem;
}

describe("taskMatchesFilters — assignee", () => {
  const SUPER_AGENT = "super-agent";

  test("a member filter keeps the cards assigned to them", () => {
    expect(
      taskMatchesFilters(
        item({ assigneeId: "user-2" }),
        {
          ...EMPTY_FILTERS,
          assignee: "user-2",
        },
        INDEX,
      ),
    ).toBe(true);
  });

  /**
   * The regression: a card handed to the Super Agent renders the delegator's
   * avatar beside the capybara, so it reads as assigned to both — and used to
   * vanish the moment you filtered by yourself.
   */
  test("a member filter keeps the cards they handed to the Super Agent", () => {
    expect(
      taskMatchesFilters(
        item({ assigneeId: SUPER_AGENT, assignedBy: "user-2" }),
        { ...EMPTY_FILTERS, assignee: "user-2" },
        INDEX,
      ),
    ).toBe(true);
  });

  test("a member filter excludes a Super Agent card someone else delegated", () => {
    expect(
      taskMatchesFilters(
        item({ assigneeId: SUPER_AGENT, assignedBy: "user-3" }),
        { ...EMPTY_FILTERS, assignee: "user-2" },
        INDEX,
      ),
    ).toBe(false);
  });

  /** `assignedBy` is stamped on every assignee change, delegation or not. */
  test("assigning a card to a teammate does not keep it under the assigner", () => {
    expect(
      taskMatchesFilters(
        item({ assigneeId: "user-3", assignedBy: "user-2" }),
        {
          ...EMPTY_FILTERS,
          assignee: "user-2",
        },
        INDEX,
      ),
    ).toBe(false);
  });

  test("the Super Agent filter keeps every card it holds, whoever delegated", () => {
    expect(
      taskMatchesFilters(
        item({ assigneeId: SUPER_AGENT, assignedBy: "user-2" }),
        { ...EMPTY_FILTERS, assignee: SUPER_AGENT },
        INDEX,
      ),
    ).toBe(true);
  });

  test("'unassigned' excludes a card the Super Agent holds", () => {
    expect(
      taskMatchesFilters(
        item({ assigneeId: SUPER_AGENT, assignedBy: "user-2" }),
        { ...EMPTY_FILTERS, assignee: "__unassigned__" },
        INDEX,
      ),
    ).toBe(false);
  });
});

describe("taskMatchesFilters — due date", () => {
  test("'week' excludes a task that is already overdue", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(
      taskMatchesFilters(
        item({ dueDate: yesterday }),
        {
          ...EMPTY_FILTERS,
          due: "week",
        },
        INDEX,
      ),
    ).toBe(false);
  });

  test("'week' includes a task due within the next 7 days", () => {
    const in3Days = new Date(
      Date.now() + 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(
      taskMatchesFilters(
        item({ dueDate: in3Days }),
        {
          ...EMPTY_FILTERS,
          due: "week",
        },
        INDEX,
      ),
    ).toBe(true);
  });

  test("'week' excludes a task due more than 7 days out", () => {
    const in10Days = new Date(
      Date.now() + 10 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(
      taskMatchesFilters(
        item({ dueDate: in10Days }),
        {
          ...EMPTY_FILTERS,
          due: "week",
        },
        INDEX,
      ),
    ).toBe(false);
  });
});

describe("taskMatchesFilters — tags", () => {
  const tag = (id: string) => ({
    id,
    name: id,
    color: null,
    createdBy: "user-1",
    createdAt: new Date().toISOString(),
  });

  test("includes a task that has one of the selected tags", () => {
    expect(
      taskMatchesFilters(
        item({ tags: [tag("a"), tag("b")] }),
        {
          ...EMPTY_FILTERS,
          tags: ["b"],
        },
        INDEX,
      ),
    ).toBe(true);
  });

  test("excludes a task that has none of the selected tags", () => {
    expect(
      taskMatchesFilters(
        item({ tags: [tag("a")] }),
        {
          ...EMPTY_FILTERS,
          tags: ["b"],
        },
        INDEX,
      ),
    ).toBe(false);
  });

  test("excludes a task with no tags when a tag filter is active", () => {
    expect(
      taskMatchesFilters(
        item({ tags: [] }),
        {
          ...EMPTY_FILTERS,
          tags: ["b"],
        },
        INDEX,
      ),
    ).toBe(false);
  });
});

describe("taskMatchesFilters — search", () => {
  test("empty search lets every task through", () => {
    expect(
      taskMatchesFilters(
        item({ title: "Fix login bug" }),
        EMPTY_FILTERS,
        INDEX,
      ),
    ).toBe(true);
  });

  test("matches a title case-insensitively", () => {
    expect(
      taskMatchesFilters(
        item({ title: "Fix Login Bug" }),
        {
          ...EMPTY_FILTERS,
          search: "login",
        },
        INDEX,
      ),
    ).toBe(true);
  });

  test("matches a description when the title doesn't match", () => {
    expect(
      taskMatchesFilters(
        item({ title: "Task", description: "Related to onboarding flow" }),
        { ...EMPTY_FILTERS, search: "onboarding" },
        INDEX,
      ),
    ).toBe(true);
  });

  test("excludes a task matching neither title nor description", () => {
    expect(
      taskMatchesFilters(
        item({ title: "Fix login bug" }),
        {
          ...EMPTY_FILTERS,
          search: "billing",
        },
        INDEX,
      ),
    ).toBe(false);
  });
});

/**
 * The repo filter, now a project filter. These are the same seven questions
 * the repo cases asked, in the new vocabulary — a bucket id where a raw
 * `owner/name` used to go. The branches the merge ADDS (a repo-less card
 * claimed by its run's project, a bucket two projects share, an id the index
 * cannot resolve) are covered where the rule lives: `lib/project-index.test.ts`.
 */
describe("taskMatchesFilters — project", () => {
  test("no project filter lets every task through", () => {
    expect(
      taskMatchesFilters(item({ repo: "acme/site" }), EMPTY_FILTERS, INDEX),
    ).toBe(true);
    expect(taskMatchesFilters(item({ repo: null }), EMPTY_FILTERS, INDEX)).toBe(
      true,
    );
  });

  test("a project matches the cards carrying its repository", () => {
    expect(
      taskMatchesFilters(
        item({ repo: "acme/site" }),
        { ...EMPTY_FILTERS, project: "acme/site" },
        INDEX,
      ),
    ).toBe(true);
  });

  test("a project excludes another project's cards", () => {
    expect(
      taskMatchesFilters(
        item({ repo: "acme/other" }),
        { ...EMPTY_FILTERS, project: "acme/site" },
        INDEX,
      ),
    ).toBe(false);
  });

  test("a project excludes a card that names none", () => {
    expect(
      taskMatchesFilters(
        item({ repo: null }),
        { ...EMPTY_FILTERS, project: "acme/site" },
        INDEX,
      ),
    ).toBe(false);
  });

  test("the match is case-insensitive (GitHub identity)", () => {
    expect(
      taskMatchesFilters(
        item({ repo: "Acme/Site" }),
        { ...EMPTY_FILTERS, project: "acme/site" },
        INDEX,
      ),
    ).toBe(true);
  });

  test("'no project' matches a card that names none", () => {
    expect(
      taskMatchesFilters(
        item({ repo: null }),
        { ...EMPTY_FILTERS, project: NO_PROJECT_FILTER },
        INDEX,
      ),
    ).toBe(true);
  });

  test("'no project' excludes a card that names one", () => {
    expect(
      taskMatchesFilters(
        item({ repo: "acme/site" }),
        { ...EMPTY_FILTERS, project: NO_PROJECT_FILTER },
        INDEX,
      ),
    ).toBe(false);
  });

  /** The filter is one clause among several, ANDed — unchanged from the repo
   *  filter, and the property a swap like this can quietly break. */
  test("narrows alongside another filter rather than replacing it", () => {
    const filters = {
      ...EMPTY_FILTERS,
      project: "acme/site",
      priority: "high" as const,
    };
    expect(
      taskMatchesFilters(
        item({ repo: "acme/site", priority: "high" }),
        filters,
        INDEX,
      ),
    ).toBe(true);
    expect(
      taskMatchesFilters(
        item({ repo: "acme/site", priority: "low" }),
        filters,
        INDEX,
      ),
    ).toBe(false);
  });
});

describe("taskMatchesProjectScope", () => {
  const siteScope = { projectId: SITE.id, repo: "acme/site" };

  test("matches an unrun task stamped with the project's repository", () => {
    expect(
      taskMatchesProjectScope(item({ repo: "Acme/Site" }), siteScope, INDEX),
    ).toBe(true);
  });

  test("rejects a task stamped for another repository", () => {
    expect(
      taskMatchesProjectScope(item({ repo: "acme/other" }), siteScope, INDEX),
    ).toBe(false);
  });

  test("an exact linked run wins even when the card names another repo", () => {
    expect(
      taskMatchesProjectScope(
        item({
          repo: "acme/other",
          threads: [{ virtualMcpId: SITE.id }] as TaskBoardItem["threads"],
        }),
        siteScope,
        INDEX,
      ),
    ).toBe(true);
  });

  test("an exact second project run wins over the first linked project", () => {
    expect(
      taskMatchesProjectScope(
        item({
          repo: "acme/other",
          threads: [
            { virtualMcpId: SIBLING.id },
            { virtualMcpId: SITE.id },
          ] as TaskBoardItem["threads"],
        }),
        siteScope,
        SHARED_REPO_INDEX,
      ),
    ).toBe(true);
  });

  test("a hidden dev partner's run belongs to its visible live project", () => {
    const resolved = resolveTaskBoardProjectScope(siteScope, [
      {
        id: "vir_dev",
        metadata: { liveAgentId: SITE.id },
      },
      {
        id: "vir_unrelated_dev",
        metadata: { liveAgentId: SIBLING.id },
      },
    ]);

    expect(resolved.relatedProjectIds).toEqual(["vir_dev"]);
    expect(
      taskMatchesProjectScope(
        item({
          repo: "acme/site",
          threads: [{ virtualMcpId: "vir_dev" }] as TaskBoardItem["threads"],
        }),
        resolved,
        SHARED_REPO_INDEX,
      ),
    ).toBe(true);
  });

  test("a development route includes its visible live partner", () => {
    const liveProjectId = "vir_live";
    const devProjectId = "vir_dev";
    const scope = resolveTaskBoardProjectScope(
      { projectId: devProjectId, repo: "deco/store" },
      [
        { id: liveProjectId },
        { id: devProjectId, metadata: { liveAgentId: liveProjectId } },
      ],
    );

    expect(scope.relatedProjectIds).toEqual([liveProjectId]);
    expect(
      taskMatchesProjectScope(
        item({
          threads: [
            { virtualMcpId: liveProjectId },
          ] as TaskBoardItem["threads"],
        }),
        scope,
        buildProjectIndex([]),
      ),
    ).toBe(true);
  });

  test("a sibling project's linked run defeats their shared repository", () => {
    expect(
      taskMatchesProjectScope(
        item({
          repo: "acme/site",
          threads: [{ virtualMcpId: SIBLING.id }] as TaskBoardItem["threads"],
        }),
        siteScope,
        SHARED_REPO_INDEX,
      ),
    ).toBe(false);
  });

  test("persisted ownership isolates projects that pin the same repository", () => {
    const task = item({ repo: "acme/site", virtualMcpId: SITE.id });
    expect(taskMatchesProjectScope(task, siteScope, SHARED_REPO_INDEX)).toBe(
      true,
    );
    expect(
      taskMatchesProjectScope(
        task,
        { projectId: SIBLING.id, repo: "acme/site" },
        SHARED_REPO_INDEX,
      ),
    ).toBe(false);
  });

  test("repo inference remains only for legacy owner-null cards", () => {
    const task = item({ repo: "acme/site", virtualMcpId: null });
    expect(taskMatchesProjectScope(task, siteScope, SHARED_REPO_INDEX)).toBe(
      true,
    );
    expect(
      taskMatchesProjectScope(
        task,
        { projectId: SIBLING.id, repo: "acme/site" },
        SHARED_REPO_INDEX,
      ),
    ).toBe(true);
  });

  test("persisted ownership outranks a sibling run and repository", () => {
    expect(
      taskMatchesProjectScope(
        item({
          virtualMcpId: SITE.id,
          repo: "acme/site",
          threads: [{ virtualMcpId: SIBLING.id }] as TaskBoardItem["threads"],
        }),
        siteScope,
        SHARED_REPO_INDEX,
      ),
    ).toBe(true);
  });

  test("persisted ownership recognizes the route's dev/live alias", () => {
    const scope = resolveTaskBoardProjectScope(siteScope, [
      { id: "vir_dev", metadata: { liveAgentId: SITE.id } },
    ]);
    expect(
      taskMatchesProjectScope(
        item({ virtualMcpId: "vir_dev", repo: "acme/other" }),
        scope,
        SHARED_REPO_INDEX,
      ),
    ).toBe(true);
  });

  test("org-wide Super Agent threads do not erase repository attribution", () => {
    const decopilotId = getWellKnownDecopilotVirtualMCP("org-1").id;
    expect(
      taskMatchesProjectScope(
        item({
          repo: "acme/site",
          threads: [{ virtualMcpId: decopilotId }] as TaskBoardItem["threads"],
        }),
        siteScope,
        INDEX,
      ),
    ).toBe(true);
  });

  test("other synthetic agent threads do not look like cold sibling projects", () => {
    expect(
      taskMatchesProjectScope(
        item({
          repo: "acme/site",
          threads: [
            { virtualMcpId: "site-diagnostics_org-1" },
          ] as TaskBoardItem["threads"],
        }),
        siteScope,
        buildProjectIndex([]),
      ),
    ).toBe(true);
  });

  test("the explicit route repo prevents a cold-index visibility flash", () => {
    expect(
      taskMatchesProjectScope(
        item({ repo: "acme/site" }),
        siteScope,
        buildProjectIndex([]),
      ),
    ).toBe(true);
  });

  test("a cold index never flashes a sibling project's linked task", () => {
    expect(
      taskMatchesProjectScope(
        item({
          repo: "acme/site",
          threads: [{ virtualMcpId: SIBLING.id }] as TaskBoardItem["threads"],
        }),
        siteScope,
        buildProjectIndex([]),
      ),
    ).toBe(false);
  });

  test("an unlisted sibling project cannot leak through a shared repo", () => {
    expect(
      taskMatchesProjectScope(
        item({
          repo: "acme/site",
          threads: [{ virtualMcpId: SIBLING.id }] as TaskBoardItem["threads"],
        }),
        siteScope,
        INDEX,
      ),
    ).toBe(false);
  });

  test("an unlisted scoped project still shares repo-only cards honestly", () => {
    expect(
      taskMatchesProjectScope(
        item({ repo: "acme/site" }),
        { projectId: SIBLING.id, repo: "acme/site" },
        INDEX,
      ),
    ).toBe(true);
  });

  test("an indexed sibling run beats an unlisted scope's shared repo", () => {
    expect(
      taskMatchesProjectScope(
        item({
          repo: "acme/site",
          threads: [{ virtualMcpId: SITE.id }] as TaskBoardItem["threads"],
        }),
        { projectId: SIBLING.id, repo: "acme/site" },
        INDEX,
      ),
    ).toBe(false);
  });

  test("a repo-less project admits its owned tasks and exact legacy runs", () => {
    const scope = { projectId: "vir_repoless", repo: null };
    expect(taskMatchesProjectScope(item({ repo: null }), scope, INDEX)).toBe(
      false,
    );
    expect(
      taskMatchesProjectScope(
        item({ repo: null, virtualMcpId: scope.projectId }),
        scope,
        INDEX,
      ),
    ).toBe(true);
    expect(
      taskMatchesProjectScope(
        item({
          repo: null,
          threads: [
            { virtualMcpId: scope.projectId },
          ] as TaskBoardItem["threads"],
        }),
        scope,
        INDEX,
      ),
    ).toBe(true);
  });
});

describe("matchesTaskKey", () => {
  test("matches the bare number, padded or not", () => {
    expect(matchesTaskKey("7", 7)).toBe(true);
    expect(matchesTaskKey("07", 7)).toBe(true);
  });

  test("matches the whole key, in any case", () => {
    expect(matchesTaskKey("DECO-07", 7)).toBe(true);
    expect(matchesTaskKey("deco-7", 7)).toBe(true);
  });

  test("does not match another card's number", () => {
    expect(matchesTaskKey("8", 7)).toBe(false);
    expect(matchesTaskKey("70", 7)).toBe(false);
  });

  test("ordinary words are not keys", () => {
    expect(matchesTaskKey("carrossel", 7)).toBe(false);
    expect(matchesTaskKey("", 7)).toBe(false);
  });

  test("a card from before the backfill never matches", () => {
    expect(matchesTaskKey("7", null)).toBe(false);
  });
});
