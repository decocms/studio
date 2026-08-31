import { describe, expect, it } from "bun:test";
import {
  jiraStatusesForLane,
  pushTargetsForLane,
  laneIndex,
  normalizeStatusMapping,
  planStatusPush,
} from "./jira-status-mapping.ts";

/** Two Jira columns collapsing into In Review — the case the push has to
 *  choose within, and the reason order is part of the shape. */
const MAPPING = {
  triage: ["Backlog"],
  in_progress: ["Doing"],
  in_review: ["Code Review", "QA"],
  done: ["Released", "Closed"],
};

describe("normalizeStatusMapping", () => {
  it("keeps a well-formed mapping, order intact", () => {
    expect(normalizeStatusMapping(MAPPING)).toEqual(MAPPING);
  });

  it("reads the legacy status → lane shape so a rolling deploy keeps syncing", () => {
    expect(
      normalizeStatusMapping({
        Backlog: "triage",
        "Code Review": "in_review",
        QA: "in_review",
      }),
    ).toEqual({ triage: ["Backlog"], in_review: ["Code Review", "QA"] });
  });

  it("gives a status to the first lane that claims it, never to two", () => {
    expect(
      normalizeStatusMapping({
        in_review: ["QA"],
        done: ["QA", "Closed"],
      }),
    ).toEqual({ in_review: ["QA"], done: ["Closed"] });
  });

  it("drops malformed entries instead of trusting stored jsonb", () => {
    expect(
      normalizeStatusMapping({
        in_review: ["QA", "", 7, null],
        done: "Closed",
        todo: [],
      }),
    ).toEqual({ in_review: ["QA"] });
  });

  it("reads a missing or non-object mapping as empty", () => {
    expect(normalizeStatusMapping(null)).toEqual({});
    expect(normalizeStatusMapping(undefined)).toEqual({});
    expect(normalizeStatusMapping([])).toEqual({});
    expect(normalizeStatusMapping("nope")).toEqual({});
  });
});

describe("laneIndex", () => {
  it("answers the pull for every status a lane groups", () => {
    const index = laneIndex(MAPPING);
    expect(index.get("Code Review")).toBe("in_review");
    expect(index.get("QA")).toBe("in_review");
    expect(index.get("Backlog")).toBe("triage");
    expect(index.get("Nothing")).toBeUndefined();
  });
});

describe("jiraStatusesForLane", () => {
  it("returns a lane's statuses leftmost-first, or nothing", () => {
    expect(jiraStatusesForLane(MAPPING, "in_review")).toEqual([
      "Code Review",
      "QA",
    ]);
    expect(jiraStatusesForLane(MAPPING, "archived")).toEqual([]);
  });
});

describe("pushTargetsForLane", () => {
  /**
   * The case this exists for, and it is not the exotic one: a tracker's board
   * column is named separately from the status it holds, so they routinely
   * differ. A real board has a column "In Progress" whose only status is
   * called "Doing". Our lane key is the COLUMN name, so without the column's
   * own status list the push has no idea what to transition the issue to.
   */
  it("uses the column's tracker status, not the column's name", () => {
    expect(
      pushTargetsForLane({
        column: { trackerStatuses: ["Doing"] },
        mapping: MAPPING,
        lane: "In Progress",
      }),
    ).toEqual(["Doing"]);
  });

  /** A column can group several statuses; order is the tracker's, and it is
   *  what decides which one the push aims for first. */
  it("keeps the tracker's order when a column groups several statuses", () => {
    expect(
      pushTargetsForLane({
        column: { trackerStatuses: ["Doing", "In Progress", "Dev"] },
        mapping: MAPPING,
        lane: "In Progress",
      }),
    ).toEqual(["Doing", "In Progress", "Dev"]);
  });

  /**
   * Studio's own columns are constants that mirror nothing, so their empty
   * list means "not a mirrored column" rather than "accepts no status". Read
   * the other way, every push on a board using Studio's lanes would die as
   * `unmapped` — which is exactly the bug on the mirrored side, inverted.
   */
  it("falls back to the hand-written mapping for a column that mirrors nothing", () => {
    expect(
      pushTargetsForLane({
        column: { trackerStatuses: [] },
        mapping: MAPPING,
        lane: "in_review",
      }),
    ).toEqual(["Code Review", "QA"]);
  });

  it("falls back for a lane this board has no column for at all", () => {
    expect(
      pushTargetsForLane({ column: undefined, mapping: MAPPING, lane: "done" }),
    ).toEqual(["Released", "Closed"]);
  });

  it("has nothing to aim at when neither side knows the lane", () => {
    expect(
      pushTargetsForLane({
        column: undefined,
        mapping: MAPPING,
        lane: "a lane nobody configured",
      }),
    ).toEqual([]);
  });
});

describe("planStatusPush", () => {
  const plan = (over: {
    lane: string;
    currentJiraStatus?: string | null;
    availableTransitions?: string[];
  }) =>
    planStatusPush({
      targets: jiraStatusesForLane(MAPPING, over.lane),
      currentJiraStatus: over.currentJiraStatus ?? null,
      availableTransitions: over.availableTransitions ?? [
        "Backlog",
        "Doing",
        "Code Review",
        "QA",
        "Released",
        "Closed",
      ],
    });

  it("enters a lane at its leftmost column, not at whichever key sorted first", () => {
    expect(plan({ lane: "in_review" })).toEqual({
      kind: "transition",
      targetName: "Code Review",
    });
    expect(plan({ lane: "done" })).toEqual({
      kind: "transition",
      targetName: "Released",
    });
  });

  it("leaves a card already somewhere in the lane where it is", () => {
    expect(plan({ lane: "in_review", currentJiraStatus: "QA" })).toEqual({
      kind: "noop",
      reason: "already-in-lane",
    });
    expect(
      plan({ lane: "in_review", currentJiraStatus: "Code Review" }),
    ).toEqual({ kind: "noop", reason: "already-in-lane" });
  });

  it("moves a card whose current status belongs to another lane", () => {
    expect(plan({ lane: "in_review", currentJiraStatus: "Doing" })).toEqual({
      kind: "transition",
      targetName: "Code Review",
    });
  });

  it("skips to the next column when the leftmost is unreachable", () => {
    expect(
      plan({ lane: "in_review", availableTransitions: ["QA", "Closed"] }),
    ).toEqual({ kind: "transition", targetName: "QA" });
  });

  it("reports an unreachable lane instead of silently doing nothing", () => {
    expect(
      plan({ lane: "in_review", availableTransitions: ["Backlog"] }),
    ).toEqual({ kind: "unreachable", targets: ["Code Review", "QA"] });
  });

  it("does nothing for a lane the org never mapped", () => {
    expect(plan({ lane: "archived" })).toEqual({
      kind: "noop",
      reason: "unmapped",
    });
  });
});
