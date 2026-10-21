import { describe, expect, test } from "bun:test";
import {
  closestCorners,
  type ClientRect,
  type DroppableContainer,
} from "@dnd-kit/core";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import {
  daysSince,
  agentRunState,
  boardCollisions,
  cardNeedsAttention,
  isCriticalTask,
  dropSwimlane,
  hasCriticalWell,
  swimlanePriority,
  CRITICAL_DROPPABLE_PREFIX,
  LANE_DROPPABLE_PREFIX,
  boardGridColumns,
  dropLane,
  dueDateUrgency,
  insertSortOrder,
  isFeedWorthyActivity,
  isLiveAttempt,
  isTaskHandedToHuman,
  laneHeader,
  laneVisibility,
  laneVisual,
  runSortOrders,
  statusIconClassName,
} from "./config";
import type { TaskBoardItem } from "./config";

function item(id: string, sortOrder: number): TaskBoardItem {
  return {
    harnessId: "claude-code",
    parentId: null,
    isEpic: false,
    id,
    organizationId: "org-1",
    boardId: "tboard-1",
    title: id,
    description: null,
    status: "triage",
    priority: "none",
    type: "chore",
    assigneeId: null,
    assignedBy: null,
    repo: null,
    repositoryId: null,
    virtualMcpId: null,
    sprintId: null,
    dueDate: null,
    sortOrder,
    keySeq: 1,
    externalUrl: null,
    previewRoutes: [],
    source: null,
    retryAttempts: 0,
    reviewCycleStartedAt: null,
    threads: [],
    tags: [],
    reviewVerdicts: [],
    statusSince: null,
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
    for (const status of [
      "triage",
      "in_progress",
      "qa",
      "ready_for_deployment",
      "done",
    ] as const) {
      expect(isTaskHandedToHuman({ ...item("t", 0), status })).toBe(false);
    }
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

describe("dropLane", () => {
  const statusOf = (id: string) =>
    ({ card_in_column: "in_progress", card_in_dead_lane: "not_a_lane" })[id];
  const over = (overId: string | undefined) => dropLane({ overId, statusOf });

  test("lands a drag in an empty column", () => {
    expect(over("lane:in_progress")).toBe("in_progress");
  });

  test("lands a drag on a card, in that card's column", () => {
    expect(over("card_in_column")).toBe("in_progress");
  });

  /** Both ways of being over a lane the board does not have are the same
   *  illegal landing: the server rejects the write either way. */
  test("refuses a lane that is not a column, hovered directly or through its card", () => {
    expect(over("lane:not_a_lane")).toBeNull();
    expect(over("card_in_dead_lane")).toBeNull();
  });

  test("refuses a card it has never heard of, and no target at all", () => {
    expect(over("card_that_left")).toBeNull();
    expect(over(undefined)).toBeNull();
  });
});

describe("boardCollisions", () => {
  function rect(left: number, top: number, width: number, height: number) {
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    } satisfies ClientRect;
  }

  // An In Review lane with a card at the top, and the empty lane beside it,
  // as tall as a board whose longest lane holds dozens of cards.
  const rects = new Map([
    ["card_in_review", rect(0, 10, 280, 100)],
    ["lane:in_review", rect(0, 0, 280, 4400)],
    ["lane:approved", rect(292, 0, 280, 4400)],
  ]);
  const containers = [...rects.keys()].map(
    (id): DroppableContainer => ({
      id,
      key: id,
      data: { current: undefined },
      disabled: false,
      node: { current: null },
      rect: { current: rects.get(id) ?? null },
    }),
  );
  /** A card dragged over the top of the empty lane. */
  const draggedOverApproved = rect(300, 20, 272, 100);

  function collide(
    detect: typeof boardCollisions,
    pointerCoordinates: { x: number; y: number } | null,
  ) {
    return detect({
      active: {
        id: "dragged",
        data: { current: undefined },
        rect: { current: { initial: null, translated: null } },
      },
      collisionRect: draggedOverApproved,
      droppableRects: rects,
      droppableContainers: containers,
      pointerCoordinates,
    })[0]?.id;
  }

  test("lands in the empty lane the pointer is inside", () => {
    expect(collide(boardCollisions, { x: 420, y: 70 })).toBe("lane:approved");
    // What the board used before: the neighbour's card measures closer.
    expect(collide(closestCorners, { x: 420, y: 70 })).toBe("card_in_review");
  });

  test("prefers a card over the lane that holds it, so reordering works", () => {
    expect(collide(boardCollisions, { x: 100, y: 50 })).toBe("card_in_review");
  });

  test("falls back to the closest corners without a pointer", () => {
    expect(collide(boardCollisions, null)).toBe("card_in_review");
  });
});

describe("laneHeader", () => {
  const t = ((key: string) => `t:${key}`) as never;

  test("translates one of the board's own lanes", () => {
    const header = laneHeader("in_progress", t);
    expect(header.label).toBe("t:taskBoard.config.statusInProgress");
    expect(header.visual).toBe(laneVisual("in_progress"));
  });

  /** A status this bundle does not know is still shown, by its raw key and
   *  with the neutral visual — not hidden, and not dressed as one of ours. */
  test("names an unknown status by its key, drawn neutral", () => {
    const header = laneHeader("not_a_lane", t);
    expect(header.label).toBe("not_a_lane");
    expect(header.visual).toBe(laneVisual("not_a_lane"));
    expect(header.visual).not.toBe(laneVisual("triage"));
  });
});

describe("laneVisibility", () => {
  test("draws every lane but the hidden-by-default ones", () => {
    const { lanes, hidden } = laneVisibility({});
    expect(lanes).toEqual([
      "triage",
      "todo",
      "in_progress",
      "in_review",
      "qa",
      "customer_approval",
      "ready_for_deployment",
      "post_deploy_validation",
      "done",
    ]);
    expect(hidden).toEqual(["archived"]);
  });

  test("showing a hidden-by-default lane puts its column back", () => {
    const { lanes, hidden } = laneVisibility({ archived: true });
    expect(lanes).toContain("archived");
    expect(hidden).toEqual([]);
  });

  test("a lane the person hid leaves the board, the others stay", () => {
    const { lanes, hidden } = laneVisibility({ qa: false, done: false });
    expect(lanes).not.toContain("qa");
    expect(lanes).not.toContain("done");
    expect(lanes).toContain("todo");
    expect(hidden).toEqual(["qa", "done", "archived"]);
  });

  test("hiding a hidden-by-default lane again keeps it hidden", () => {
    const { lanes, hidden } = laneVisibility({ archived: false });
    expect(lanes).not.toContain("archived");
    expect(hidden).toEqual(["archived"]);
  });

  test("a lane removed from the product can linger in the preference", () => {
    const { lanes } = laneVisibility({
      a_lane_that_no_longer_exists: true,
      another_dead_lane: false,
    });
    expect(lanes).not.toContain("a_lane_that_no_longer_exists");
    expect(lanes).toContain("todo");
  });
});

describe("isFeedWorthyActivity", () => {
  test("drops the per-retry line — it says nothing a person acts on", () => {
    expect(
      isFeedWorthyActivity({
        action: "status_changed",
        data: { from: "in_progress", to: "in_progress", retry: 1, of: 1 },
      }),
    ).toBe(false);
  });

  test("keeps the terminal line that counts the retries", () => {
    expect(
      isFeedWorthyActivity({
        action: "status_changed",
        data: { from: "in_progress", to: "triage", retriesSpent: 1 },
      }),
    ).toBe(true);
  });

  test("keeps ordinary moves, and anything that is not a status change", () => {
    expect(
      isFeedWorthyActivity({
        action: "status_changed",
        data: { from: "triage", to: "in_progress" },
      }),
    ).toBe(true);
    expect(isFeedWorthyActivity({ action: "created", data: null })).toBe(true);
    // `retry` is only a retry when it is a count — a stray string is not one.
    expect(
      isFeedWorthyActivity({ action: "status_changed", data: { retry: "1" } }),
    ).toBe(true);
  });
});

describe("isLiveAttempt", () => {
  test("drops a superseded attempt — a newer run replaced it", () => {
    expect(isLiveAttempt({ failureKind: "superseded" })).toBe(false);
  });

  test("keeps the attempt that actually ended the card", () => {
    // The last attempt is never superseded (nothing replaced it), so a card
    // whose every run failed still shows one card, and one transcript.
    expect(isLiveAttempt({ failureKind: "error" })).toBe(true);
    expect(isLiveAttempt({ failureKind: "ended_after_delivery" })).toBe(true);
    expect(isLiveAttempt({ failureKind: null })).toBe(true);
    expect(isLiveAttempt({})).toBe(true);
  });
});

describe("daysSince", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  test("counts whole days", () => {
    expect(daysSince("2026-09-25T13:00:00Z", now)).toBe(2);
    expect(daysSince("2026-09-25T12:00:00Z", now)).toBe(3);
  });
  test("the same day, or a timestamp ahead of the clock, is 0", () => {
    expect(daysSince("2026-09-28T01:00:00Z", now)).toBe(0);
    expect(daysSince("2026-09-29T00:00:00Z", now)).toBe(0);
  });
});

describe("boardGridColumns", () => {
  test("gives every open lane a shared, flexible track", () => {
    expect(
      boardGridColumns({
        lanes: ["triage", "in_progress"],
        collapsed: [],
        hasHiddenTail: false,
      }),
    ).toBe("minmax(280px, 1fr) minmax(280px, 1fr)");
  });

  test("narrows a collapsed lane to a fixed strip, in place", () => {
    expect(
      boardGridColumns({
        lanes: ["triage", "in_progress", "done"],
        collapsed: ["in_progress"],
        hasHiddenTail: false,
      }),
    ).toBe("minmax(280px, 1fr) 44px minmax(280px, 1fr)");
  });

  test("keeps a track for the hidden-lanes tail", () => {
    expect(
      boardGridColumns({
        lanes: ["triage"],
        collapsed: ["triage"],
        hasHiddenTail: true,
      }),
    ).toBe("44px 280px");
  });

  // localStorage can name a lane the board no longer has.
  test("ignores a collapsed lane the board does not draw", () => {
    expect(
      boardGridColumns({
        lanes: ["triage"],
        collapsed: ["a_lane_that_no_longer_exists"],
        hasHiddenTail: false,
      }),
    ).toBe("minmax(280px, 1fr)");
  });
});

describe("isCriticalTask", () => {
  const at = (patch: Partial<TaskBoardItem>) => ({ ...item("t", 0), ...patch });

  test("urgent, security, blocked and failed work is critical", () => {
    expect(isCriticalTask(at({ priority: "urgent" }))).toBe(true);
    expect(isCriticalTask(at({ type: "security" }))).toBe(true);
    expect(
      isCriticalTask(
        at({
          threads: [{ status: "requires_action" }] as TaskBoardItem["threads"],
        }),
      ),
    ).toBe(true);
  });

  test("ordinary and high-priority work is an improvement", () => {
    expect(isCriticalTask(at({ priority: "high" }))).toBe(false);
    expect(isCriticalTask(at({ priority: "medium" }))).toBe(false);
    expect(isCriticalTask(at({ priority: "none", type: "feature" }))).toBe(
      false,
    );
  });

  test("settled cards never count, however urgent", () => {
    expect(isCriticalTask(at({ priority: "urgent", status: "done" }))).toBe(
      false,
    );
    expect(isCriticalTask(at({ type: "security", status: "archived" }))).toBe(
      false,
    );
  });
});

describe("dropSwimlane", () => {
  const cards = new Map([
    ["urgent", { ...item("urgent", 0), priority: "urgent" as const }],
    ["plain", item("plain", 1)],
  ]);
  const over = (
    overId: string | undefined,
    fromStatus = "todo",
    toStatus = "todo",
  ) =>
    dropSwimlane({
      overId,
      itemOf: (id) => cards.get(id),
      fromStatus,
      toStatus,
    });

  test("a well's own droppable names its swimlane", () => {
    expect(over(`${CRITICAL_DROPPABLE_PREFIX}todo`)).toBe("critical");
    expect(over(`${LANE_DROPPABLE_PREFIX}todo`)).toBe("improvements");
  });

  test("a card names the swimlane it sits in", () => {
    expect(over("urgent")).toBe("critical");
    expect(over("plain")).toBe("improvements");
  });

  test("nothing under the pointer is no swimlane", () => {
    expect(over(undefined)).toBeNull();
    expect(over("gone")).toBeNull();
  });

  test("a lane change keeps the card's well unless dropped on Critical", () => {
    expect(over("plain", "todo", "in_progress")).toBeNull();
    expect(over("urgent", "todo", "in_progress")).toBeNull();
    expect(
      over(`${LANE_DROPPABLE_PREFIX}in_progress`, "todo", "in_progress"),
    ).toBeNull();
    expect(
      over(`${CRITICAL_DROPPABLE_PREFIX}in_progress`, "todo", "in_progress"),
    ).toBe("critical");
  });

  test("Done and Archived have no swimlanes", () => {
    for (const status of ["done", "archived"]) {
      expect(hasCriticalWell(status)).toBe(false);
      expect(over("plain", "todo", status)).toBeNull();
      expect(
        over(`${LANE_DROPPABLE_PREFIX}${status}`, "todo", status),
      ).toBeNull();
      expect(over("plain", status, status)).toBeNull();
    }
    expect(hasCriticalWell("todo")).toBe(true);
  });

  test("an urgent card keeps its priority across a lane round trip", () => {
    const urgent = cards.get("urgent")!;
    // Out to In Progress over an Improvements card, then back over one.
    for (const [from, to] of [
      ["todo", "in_progress"],
      ["in_progress", "todo"],
    ] as const) {
      const swimlane = over("plain", from, to);
      expect(swimlane && swimlanePriority(urgent, swimlane)).toBeNull();
    }
  });

  test("an urgent card dropped in Done keeps its priority", () => {
    const urgent = cards.get("urgent")!;
    const swimlane = over(`${LANE_DROPPABLE_PREFIX}done`, "todo", "done");
    expect(swimlane && swimlanePriority(urgent, swimlane)).toBeNull();
  });
});

describe("swimlanePriority", () => {
  const at = (patch: Partial<TaskBoardItem>) => ({ ...item("t", 0), ...patch });

  test("into Critical makes a card urgent", () => {
    expect(swimlanePriority(at({ priority: "low" }), "critical")).toBe(
      "urgent",
    );
    expect(swimlanePriority(at({ priority: "high" }), "critical")).toBe(
      "urgent",
    );
  });

  test("a card already in its swimlane needs no change", () => {
    expect(swimlanePriority(at({ priority: "urgent" }), "critical")).toBeNull();
    expect(
      swimlanePriority(at({ priority: "medium" }), "improvements"),
    ).toBeNull();
  });

  test("out of Critical lowers a card that priority alone kept there", () => {
    expect(swimlanePriority(at({ priority: "urgent" }), "improvements")).toBe(
      "high",
    );
  });

  test("a security card stays critical, so its priority is left alone", () => {
    expect(
      swimlanePriority(
        at({ priority: "urgent", type: "security" }),
        "improvements",
      ),
    ).toBeNull();
  });
});
