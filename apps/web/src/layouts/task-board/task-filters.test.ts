import { describe, expect, test } from "bun:test";
import {
  matchesTaskKey,
  taskMatchesFilters,
  EMPTY_FILTERS,
} from "./task-filters";
import { buildProjectIndex, NO_PROJECT_FILTER } from "@/lib/project-index";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import type { TaskBoardItem } from "./config";

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
