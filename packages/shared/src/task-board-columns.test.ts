import { describe, expect, it } from "bun:test";
import {
  columnForItem,
  DEFAULT_TASK_BOARD_COLUMNS,
  resolveBoardColumns,
  shouldTriggerColumnAutomation,
} from "./task-board-columns";
import type { TaskBoardColumnConfig } from "./organization/schema";

const CUSTOM: TaskBoardColumnConfig[] = [
  { id: "triage", name: null, stage: "triage" },
  { id: "doing", name: "Doing", stage: "in_progress" },
  {
    id: "qa",
    name: "QA",
    stage: "in_review",
    automation: { enabled: true, agentId: "agent-1" },
  },
  { id: "done", name: null, stage: "done" },
];

describe("resolveBoardColumns", () => {
  it("falls back to the defaults for null/empty config", () => {
    expect(resolveBoardColumns(null)).toEqual(DEFAULT_TASK_BOARD_COLUMNS);
    expect(resolveBoardColumns(undefined)).toEqual(DEFAULT_TASK_BOARD_COLUMNS);
    expect(resolveBoardColumns([])).toEqual(DEFAULT_TASK_BOARD_COLUMNS);
  });

  it("drops columns with an unknown stage, defaulting when none survive", () => {
    const bad = { id: "x", name: "X", stage: "nope" as never };
    expect(resolveBoardColumns([bad])).toEqual(DEFAULT_TASK_BOARD_COLUMNS);
    expect(resolveBoardColumns([CUSTOM[1]!, bad])).toEqual([CUSTOM[1]!]);
  });

  it("keeps a valid custom set as-is, in order", () => {
    expect(resolveBoardColumns(CUSTOM)).toEqual(CUSTOM);
  });
});

describe("columnForItem", () => {
  it("prefers the explicit columnId when it exists", () => {
    const item = { status: "in_review" as const, columnId: "qa" };
    expect(columnForItem(item, CUSTOM).id).toBe("qa");
  });

  it("falls back to the first column of the item's stage", () => {
    const item = { status: "in_progress" as const, columnId: null };
    expect(columnForItem(item, CUSTOM).id).toBe("doing");
    // A stale columnId (column deleted) also falls back to the stage.
    const stale = { status: "in_progress" as const, columnId: "gone" };
    expect(columnForItem(stale, CUSTOM).id).toBe("doing");
  });

  it("lands in the first column when the stage has no column", () => {
    // CUSTOM has no "todo" column.
    const item = { status: "todo" as const, columnId: null };
    expect(columnForItem(item, CUSTOM).id).toBe("triage");
  });
});

describe("shouldTriggerColumnAutomation", () => {
  const qa = CUSTOM[2]!;
  const base = {
    column: qa,
    previousColumnId: "doing",
    automationColumnId: null,
    threads: [],
  };

  it("triggers on entering an automated column", () => {
    expect(shouldTriggerColumnAutomation(base)).toBe(true);
  });

  it("never triggers a column without automation", () => {
    expect(shouldTriggerColumnAutomation({ ...base, column: CUSTOM[1]! })).toBe(
      false,
    );
  });

  it("skips when the task did not actually change column", () => {
    expect(
      shouldTriggerColumnAutomation({ ...base, previousColumnId: "qa" }),
    ).toBe(false);
  });

  it("skips a run-driven bounce (guard stamp set to this column)", () => {
    expect(
      shouldTriggerColumnAutomation({ ...base, automationColumnId: "qa" }),
    ).toBe(false);
  });

  it("re-arms after a human move cleared the stamp", () => {
    expect(
      shouldTriggerColumnAutomation({ ...base, automationColumnId: null }),
    ).toBe(true);
  });

  it("skips while a linked run is still in progress", () => {
    expect(
      shouldTriggerColumnAutomation({
        ...base,
        threads: [{ status: "in_progress" }, { status: "completed" }],
      }),
    ).toBe(false);
    expect(
      shouldTriggerColumnAutomation({
        ...base,
        threads: [{ status: "completed" }, { status: null }],
      }),
    ).toBe(true);
  });
});
