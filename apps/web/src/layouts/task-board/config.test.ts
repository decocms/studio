import { describe, expect, test } from "bun:test";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import {
  agentRunState,
  cardNeedsAttention,
  dueDateUrgency,
  formatSprintDates,
  insertSortOrder,
  isTaskHandedToHuman,
  laneVisibility,
  moveTargets,
  runSortOrders,
  statusIconClassName,
  STATUSES,
} from "./config";
import type { TaskBoardItem } from "./config";

function item(id: string, sortOrder: number): TaskBoardItem {
  return {
    id,
    organizationId: "org-1",
    title: id,
    description: null,
    status: "todo",
    priority: "none",
    type: "chore",
    sprintId: null,
    assigneeId: null,
    assignedBy: null,
    repo: null,
    dueDate: null,
    sortOrder,
    keySeq: 1,
    retryAttempts: 0,
    threads: [],
    tags: [],
    reviewVerdicts: [],
    createdBy: "user-1",
    createdAt: new Date().toISOString(),
    updatedBy: "user-1",
    updatedAt: new Date().toISOString(),
  } as TaskBoardItem;
}

describe("insertSortOrder", () => {
  const lane = [item("a", 0), item("b", 10), item("c", 20)];

  test("lands between its two new neighbors", () => {
    // Drop "a" so it lands right before "c" (i.e. between "b" and "c").
    expect(insertSortOrder(lane, "c", "a")).toBe(15);
  });

  test("lands at the end when beforeId is null", () => {
    expect(insertSortOrder(lane, null, "a")).toBe(21);
  });

  test("lands at the start when there is no prev neighbor", () => {
    // Drop "c" so it lands right before "a" (i.e. at the very start).
    expect(insertSortOrder(lane, "a", "c")).toBe(-1);
  });

  test("hovering the dragged card's own row is a no-op, not a jump to the end", () => {
    // "b" is dragged and hovered over its own (upper-half) row, which reports
    // itself as beforeId. It must stay between "a" and "c", not jump last.
    expect(insertSortOrder(lane, "b", "b")).toBe(10);
  });

  test("hovering the last card's own row still resolves to the end", () => {
    expect(insertSortOrder(lane, "c", "c")).toBe(11);
  });
});

describe("runSortOrders", () => {
  test("a single card lands exactly on the drop slot", () => {
    expect(runSortOrders(10, 1)).toEqual([10]);
  });

  test("a dragged group keeps its order and ends at the drop slot", () => {
    const orders = runSortOrders(10, 3);
    // Ascending — lanes sort by sortOrder asc, so input order must survive the
    // round trip through the DB. Reversing the offset here reverses the group.
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(orders.at(-1)).toBe(10);
  });

  test("the whole run sits at or before the drop slot", () => {
    for (const order of runSortOrders(10, 5))
      expect(order).toBeLessThanOrEqual(10);
  });
});

describe("statusIconClassName", () => {
  const working = { ...item("a", 0), status: "in_progress" } as TaskBoardItem;
  const blocked = {
    ...working,
    threads: [{ status: "requires_action" }],
  } as TaskBoardItem;

  test("an in-progress task does not spin", () => {
    expect(statusIconClassName(working)).not.toContain("animate-spin");
  });

  test("one waiting on input pulses in warning instead", () => {
    expect(statusIconClassName(blocked)).toBe("text-warning animate-pulse");
  });

  test("other statuses keep their static class", () => {
    expect(statusIconClassName(item("a", 0))).toBe("text-muted-foreground");
  });
});

/**
 * The card badge for a task the automation gave up on. Without it a handed-off
 * card renders exactly like one still waiting on its reviewers, which is how
 * five sat In Review for a week in one org with nobody noticing.
 */
describe("isTaskHandedToHuman", () => {
  const inReview = (assigneeId: string | null): TaskBoardItem => ({
    ...item("t", 0),
    status: "in_review",
    assigneeId,
  });

  test("an In Review card with no assignee is waiting on a person", () => {
    expect(isTaskHandedToHuman(inReview(null))).toBe(true);
  });

  test("a card the Super Agent or a human still owns is not", () => {
    expect(isTaskHandedToHuman(inReview(SUPER_AGENT_ASSIGNEE_ID))).toBe(false);
    expect(isTaskHandedToHuman(inReview("user-1"))).toBe(false);
  });

  // Unassigned is the norm everywhere else on the board — only In Review means
  // automation stopped.
  test("an unassigned card in any other lane is not", () => {
    for (const status of ["triage", "todo", "in_progress", "done"] as const) {
      expect(isTaskHandedToHuman({ ...item("t", 0), status })).toBe(false);
    }
  });
});

describe("formatSprintDates", () => {
  const sprint = {
    id: "sprint_1",
    name: "Sprint 12",
    state: "active" as const,
    startsAt: "2026-01-05T00:00:00.000Z",
    endsAt: "2026-01-18T00:00:00.000Z",
  };

  test("spans the sprint's own days, read in UTC", () => {
    // Day numbers, not the whole string: month names follow the test locale.
    const label = formatSprintDates(sprint);
    expect(label).toContain("5");
    expect(label).toContain("18");
  });

  test("renders the one date it has when the other is missing", () => {
    expect(formatSprintDates({ ...sprint, endsAt: null })).toContain("5");
    expect(formatSprintDates({ ...sprint, startsAt: null })).toContain("18");
  });

  test("is null for a sprint nobody has scheduled", () => {
    expect(formatSprintDates({ ...sprint, startsAt: null, endsAt: null })).toBe(
      null,
    );
  });

  test("is null rather than `Invalid Date` for an unparseable date", () => {
    expect(
      formatSprintDates({ ...sprint, startsAt: "nope", endsAt: null }),
    ).toBe(null);
  });
});

/**
 * The card's one dot of run state. It exists because the card no longer has an
 * agent footer, and a card whose run died must not look like a card that is
 * simply idle.
 */
describe("agentRunState", () => {
  const withThreads = (
    threads: { status: string; failureKind?: string | null }[],
  ) => ({ ...item("a", 0), threads }) as unknown as TaskBoardItem;

  test("no threads, nothing to say", () => {
    expect(agentRunState(item("a", 0))).toBeNull();
  });

  test("a completed run is not a pulse", () => {
    expect(agentRunState(withThreads([{ status: "completed" }]))).toBeNull();
  });

  test("an in-progress run is running", () => {
    expect(agentRunState(withThreads([{ status: "in_progress" }]))).toBe(
      "running",
    );
  });

  test("an unresolved failure is failed", () => {
    expect(
      agentRunState(withThreads([{ status: "failed", failureKind: null }])),
    ).toBe("failed");
  });

  test("a live run outranks an earlier attempt's error", () => {
    expect(
      agentRunState(
        withThreads([
          { status: "failed", failureKind: null },
          { status: "in_progress" },
        ]),
      ),
    ).toBe("running");
  });

  test("a failure that is settled history is not the task's failure", () => {
    for (const failureKind of ["superseded", "ended_after_delivery"]) {
      expect(
        agentRunState(withThreads([{ status: "failed", failureKind }])),
      ).toBe(null);
    }
  });
});

describe("dueDateUrgency", () => {
  const now = Date.parse("2026-03-10T12:00:00.000Z");
  const at = (iso: string) => dueDateUrgency(iso, now);

  test("a date in the past is overdue", () => {
    expect(at("2026-03-10T11:59:00.000Z")).toBe("overdue");
    expect(at("2026-01-01T00:00:00.000Z")).toBe("overdue");
  });

  test("within three days is soon", () => {
    expect(at("2026-03-10T18:00:00.000Z")).toBe("soon");
    expect(at("2026-03-13T11:00:00.000Z")).toBe("soon");
  });

  test("further out earns no ink on a card", () => {
    expect(at("2026-03-13T13:00:00.000Z")).toBeNull();
    expect(at("2026-09-01T00:00:00.000Z")).toBeNull();
  });

  test("an unparseable date is not urgent", () => {
    expect(at("not a date")).toBeNull();
  });
});

/**
 * The one state that colours a whole card. Narrowed to `requires_action`
 * alone: the hand-off signal it used to include is `in_review && !assigneeId`,
 * which every unowned card in the lane matches, so the colour stopped meaning
 * anything. An empty assignee slot in the footer carries that case instead.
 */
describe("cardNeedsAttention", () => {
  const inReview = (assigneeId: string | null) =>
    ({ ...item("a", 0), status: "in_review", assigneeId }) as TaskBoardItem;
  const asking = (base: TaskBoardItem) =>
    ({ ...base, threads: [{ status: "requires_action" }] }) as TaskBoardItem;

  test("a quiet card needs nobody", () => {
    expect(cardNeedsAttention(item("a", 0))).toBe(false);
  });

  test("an agent waiting on input needs attention", () => {
    expect(cardNeedsAttention(asking(item("a", 0)))).toBe(true);
  });

  // Inverted: this used to colour the card, and matched nearly every card in
  // the In Review lane.
  test("In Review with no owner does NOT colour the card", () => {
    expect(cardNeedsAttention(inReview(null))).toBe(false);
  });

  test("an owner makes no difference either way", () => {
    expect(cardNeedsAttention(inReview("user-1"))).toBe(false);
    expect(cardNeedsAttention(asking(inReview("user-1")))).toBe(true);
  });
});

describe("moveTargets", () => {
  test("offers no delivery lane to a board that doesn't run them", () => {
    expect(moveTargets(false)).toEqual([
      "triage",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "archived",
    ]);
  });

  test("offers every lane once they're on", () => {
    expect(moveTargets(true)).toEqual(STATUSES);
  });
});

describe("laneVisibility", () => {
  const shown: string[] = [];

  test("draws the delivery lanes as columns when they're on", () => {
    const { lanes, hidden } = laneVisibility({
      deliveryEnabled: true,
      shownLanes: shown,
      occupied: [],
    });
    expect(lanes).toEqual([
      "triage",
      "todo",
      "in_progress",
      "in_review",
      "approved",
      "merged",
      "post_deploy_validation",
      "done",
      // archived is hidden by default
    ]);
    expect(hidden).toEqual(["archived"]);
  });

  test("an empty delivery lane is absent, not hidden, when they're off", () => {
    const { lanes, hidden } = laneVisibility({
      deliveryEnabled: false,
      shownLanes: shown,
      occupied: [],
    });
    expect(lanes).toEqual([
      "triage",
      "todo",
      "in_progress",
      "in_review",
      "done",
    ]);
    expect(hidden).toEqual(["archived"]);
  });

  // Lanes off with work still in one: the card must stay reachable.
  test("a card left in a delivery lane keeps the lane in the drawer", () => {
    const { lanes, hidden, hideable } = laneVisibility({
      deliveryEnabled: false,
      shownLanes: shown,
      occupied: ["merged"],
    });
    expect(lanes).not.toContain("merged");
    expect(hidden).toEqual(["merged", "archived"]);
    expect(hideable).toContain("merged");
  });

  test("and showing it puts the column back", () => {
    const { lanes, hidden } = laneVisibility({
      deliveryEnabled: false,
      shownLanes: ["merged"],
      occupied: ["merged"],
    });
    expect(lanes).toContain("merged");
    expect(hidden).toEqual(["archived"]);
  });

  test("a lane removed from the product can linger in the preference", () => {
    const { lanes } = laneVisibility({
      deliveryEnabled: false,
      shownLanes: ["a_lane_that_no_longer_exists"],
      occupied: [],
    });
    expect(lanes).not.toContain("a_lane_that_no_longer_exists");
  });
});
