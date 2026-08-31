import { describe, expect, test } from "bun:test";
import {
  matchesTaskKey,
  resolveSprintFilter,
  taskMatchesFilters,
  EMPTY_FILTERS,
} from "./task-filters";
import type { TaskBoardItem } from "./config";

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

/**
 * A board that runs sprints opens on the running one, so an absent param means
 * "nobody has chosen yet" rather than "no filter". The URL also outlives the
 * sprint it names, and an unknown id left in place would hide every card behind
 * a chip that reads exactly like "no sprint filter".
 */
describe("resolveSprintFilter", () => {
  const sprint = (id: string, state: "active" | "future" | "closed") => ({
    id,
    name: id,
    state,
    startsAt: null,
    endsAt: null,
  });
  const sprints = [sprint("sprint_a", "active"), sprint("sprint_b", "future")];

  test("keeps a sprint the board actually has", () => {
    expect(resolveSprintFilter("sprint_b", sprints)).toBe("sprint_b");
  });

  test("opens on the running sprint when the URL says nothing", () => {
    expect(resolveSprintFilter(null, sprints)).toBe("sprint_a");
  });

  /** Inverts the pre-default behaviour: both used to resolve to "any sprint". */
  test("falls back to the running sprint for an id the board lost", () => {
    expect(resolveSprintFilter("sprint_gone", sprints)).toBe("sprint_a");
  });

  test("shows every sprint only when asked", () => {
    expect(resolveSprintFilter("all", sprints)).toBe(null);
  });

  test("has no default to apply without a running sprint", () => {
    expect(resolveSprintFilter(null, [])).toBe(null);
    expect(resolveSprintFilter(null, [sprint("sprint_b", "future")])).toBe(
      null,
    );
    expect(resolveSprintFilter("sprint_gone", [])).toBe(null);
  });

  test("picks one running sprint when the tracker has several", () => {
    expect(
      resolveSprintFilter(null, [
        sprint("sprint_z", "active"),
        sprint("sprint_a", "active"),
      ]),
    ).toBe("sprint_a");
  });

  test("leaves the backlog sentinel alone, default or not", () => {
    expect(resolveSprintFilter("backlog", [])).toBe("backlog");
    expect(resolveSprintFilter("backlog", sprints)).toBe("backlog");
  });
});

describe("taskMatchesFilters — sprint", () => {
  test("a sprint filter keeps only that sprint", () => {
    expect(
      taskMatchesFilters(item({ sprintId: "sprint_a" }), {
        ...EMPTY_FILTERS,
        sprint: "sprint_a",
      }),
    ).toBe(true);
    expect(
      taskMatchesFilters(item({ sprintId: "sprint_b" }), {
        ...EMPTY_FILTERS,
        sprint: "sprint_a",
      }),
    ).toBe(false);
  });

  test("the backlog filter keeps only tasks with no sprint", () => {
    expect(
      taskMatchesFilters(item({ sprintId: null }), {
        ...EMPTY_FILTERS,
        sprint: "backlog",
      }),
    ).toBe(true);
    expect(
      taskMatchesFilters(item({ sprintId: "sprint_a" }), {
        ...EMPTY_FILTERS,
        sprint: "backlog",
      }),
    ).toBe(false);
  });

  test("no sprint filter keeps both planned and backlog tasks", () => {
    expect(
      taskMatchesFilters(item({ sprintId: "sprint_a" }), EMPTY_FILTERS),
    ).toBe(true);
    expect(taskMatchesFilters(item({ sprintId: null }), EMPTY_FILTERS)).toBe(
      true,
    );
  });
});

describe("taskMatchesFilters — assignee", () => {
  const SUPER_AGENT = "super-agent";

  test("a member filter keeps the cards assigned to them", () => {
    expect(
      taskMatchesFilters(item({ assigneeId: "user-2" }), {
        ...EMPTY_FILTERS,
        assignee: "user-2",
      }),
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
      ),
    ).toBe(true);
  });

  test("a member filter excludes a Super Agent card someone else delegated", () => {
    expect(
      taskMatchesFilters(
        item({ assigneeId: SUPER_AGENT, assignedBy: "user-3" }),
        { ...EMPTY_FILTERS, assignee: "user-2" },
      ),
    ).toBe(false);
  });

  /** `assignedBy` is stamped on every assignee change, delegation or not. */
  test("assigning a card to a teammate does not keep it under the assigner", () => {
    expect(
      taskMatchesFilters(item({ assigneeId: "user-3", assignedBy: "user-2" }), {
        ...EMPTY_FILTERS,
        assignee: "user-2",
      }),
    ).toBe(false);
  });

  test("the Super Agent filter keeps every card it holds, whoever delegated", () => {
    expect(
      taskMatchesFilters(
        item({ assigneeId: SUPER_AGENT, assignedBy: "user-2" }),
        { ...EMPTY_FILTERS, assignee: SUPER_AGENT },
      ),
    ).toBe(true);
  });

  test("'unassigned' excludes a card the Super Agent holds", () => {
    expect(
      taskMatchesFilters(
        item({ assigneeId: SUPER_AGENT, assignedBy: "user-2" }),
        { ...EMPTY_FILTERS, assignee: "__unassigned__" },
      ),
    ).toBe(false);
  });
});

describe("taskMatchesFilters — due date", () => {
  test("'week' excludes a task that is already overdue", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(
      taskMatchesFilters(item({ dueDate: yesterday }), {
        ...EMPTY_FILTERS,
        due: "week",
      }),
    ).toBe(false);
  });

  test("'week' includes a task due within the next 7 days", () => {
    const in3Days = new Date(
      Date.now() + 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(
      taskMatchesFilters(item({ dueDate: in3Days }), {
        ...EMPTY_FILTERS,
        due: "week",
      }),
    ).toBe(true);
  });

  test("'week' excludes a task due more than 7 days out", () => {
    const in10Days = new Date(
      Date.now() + 10 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(
      taskMatchesFilters(item({ dueDate: in10Days }), {
        ...EMPTY_FILTERS,
        due: "week",
      }),
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
      taskMatchesFilters(item({ tags: [tag("a"), tag("b")] }), {
        ...EMPTY_FILTERS,
        tags: ["b"],
      }),
    ).toBe(true);
  });

  test("excludes a task that has none of the selected tags", () => {
    expect(
      taskMatchesFilters(item({ tags: [tag("a")] }), {
        ...EMPTY_FILTERS,
        tags: ["b"],
      }),
    ).toBe(false);
  });

  test("excludes a task with no tags when a tag filter is active", () => {
    expect(
      taskMatchesFilters(item({ tags: [] }), {
        ...EMPTY_FILTERS,
        tags: ["b"],
      }),
    ).toBe(false);
  });
});

describe("taskMatchesFilters — search", () => {
  test("empty search lets every task through", () => {
    expect(
      taskMatchesFilters(item({ title: "Fix login bug" }), EMPTY_FILTERS),
    ).toBe(true);
  });

  test("matches a title case-insensitively", () => {
    expect(
      taskMatchesFilters(item({ title: "Fix Login Bug" }), {
        ...EMPTY_FILTERS,
        search: "login",
      }),
    ).toBe(true);
  });

  test("matches a description when the title doesn't match", () => {
    expect(
      taskMatchesFilters(
        item({ title: "Task", description: "Related to onboarding flow" }),
        { ...EMPTY_FILTERS, search: "onboarding" },
      ),
    ).toBe(true);
  });

  test("excludes a task matching neither title nor description", () => {
    expect(
      taskMatchesFilters(item({ title: "Fix login bug" }), {
        ...EMPTY_FILTERS,
        search: "billing",
      }),
    ).toBe(false);
  });
});

describe("taskMatchesFilters — repo", () => {
  // NO_REPO_FILTER is module-private; assert against its raw sentinel value.
  const NO_REPO = "__no_repo__";

  test("no repo filter lets every task through", () => {
    expect(taskMatchesFilters(item({ repo: "acme/site" }), EMPTY_FILTERS)).toBe(
      true,
    );
    expect(taskMatchesFilters(item({ repo: null }), EMPTY_FILTERS)).toBe(true);
  });

  test("a specific repo matches the same repo", () => {
    expect(
      taskMatchesFilters(item({ repo: "acme/site" }), {
        ...EMPTY_FILTERS,
        repo: "acme/site",
      }),
    ).toBe(true);
  });

  test("a specific repo excludes a different repo", () => {
    expect(
      taskMatchesFilters(item({ repo: "acme/other" }), {
        ...EMPTY_FILTERS,
        repo: "acme/site",
      }),
    ).toBe(false);
  });

  test("a specific repo excludes a task with no repo", () => {
    expect(
      taskMatchesFilters(item({ repo: null }), {
        ...EMPTY_FILTERS,
        repo: "acme/site",
      }),
    ).toBe(false);
  });

  test("repo match is case-insensitive (GitHub identity)", () => {
    expect(
      taskMatchesFilters(item({ repo: "Acme/Site" }), {
        ...EMPTY_FILTERS,
        repo: "acme/site",
      }),
    ).toBe(true);
  });

  test("'no repo' matches a task with no repo", () => {
    expect(
      taskMatchesFilters(item({ repo: null }), {
        ...EMPTY_FILTERS,
        repo: NO_REPO,
      }),
    ).toBe(true);
  });

  test("'no repo' excludes a repo-backed task", () => {
    expect(
      taskMatchesFilters(item({ repo: "acme/site" }), {
        ...EMPTY_FILTERS,
        repo: NO_REPO,
      }),
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

/**
 * The collision this exists to prevent: `parseTaskKeySeq` ignores a term's
 * prefix, so before the tracker key was consulted, searching `EX-333` resolved
 * to the number 333 and quietly matched whichever unrelated card held Studio
 * sequence 333 — while missing the card actually named EX-333.
 */
describe("matchesTaskKey with a tracker key", () => {
  test("finds a synced card by the key it shows, any case", () => {
    expect(matchesTaskKey("EX-333", 320, "EX-333")).toBe(true);
    expect(matchesTaskKey("ex-333", 320, "EX-333")).toBe(true);
    expect(matchesTaskKey("  EX-333  ", 320, "EX-333")).toBe(true);
  });

  test("does not match a synced card by the sequence it no longer shows", () => {
    expect(matchesTaskKey("ACME-320", 320, "EX-333")).toBe(false);
  });

  test("never lets a tracker key match an unrelated card's sequence", () => {
    expect(matchesTaskKey("EX-333", 333, "EX-999")).toBe(false);
    expect(matchesTaskKey("EX-333", 333, null)).toBe(true);
  });

  test("takes a bare number against either vocabulary, ambiguity included", () => {
    expect(matchesTaskKey("333", 320, "EX-333")).toBe(true);
    expect(matchesTaskKey("0333", 320, "EX-333")).toBe(true);
    expect(matchesTaskKey("320", 320, "EX-333")).toBe(false);
    expect(matchesTaskKey("333", 333, null)).toBe(true);
  });

  test("an empty or unparseable term names nothing", () => {
    expect(matchesTaskKey("", 320, "EX-333")).toBe(false);
    expect(matchesTaskKey("   ", 320, "EX-333")).toBe(false);
    expect(matchesTaskKey("schema", 320, "EX-333")).toBe(false);
  });
});
