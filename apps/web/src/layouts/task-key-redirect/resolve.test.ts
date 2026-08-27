import { describe, expect, test } from "bun:test";
import { findTaskByKeyOrId } from "./resolve";

const items = [
  { id: "board_abc", keySeq: 1, jiraIssueKey: null },
  { id: "board_def", keySeq: 12, jiraIssueKey: null },
  { id: "board_ghi", keySeq: null, jiraIssueKey: null },
  { id: "board_jkl", keySeq: 333, jiraIssueKey: null },
  { id: "board_mno", keySeq: 5, jiraIssueKey: "OS-333" },
];

describe("findTaskByKeyOrId", () => {
  test("resolves the full key, in any case or padding", () => {
    expect(findTaskByKeyOrId(items, "DECO-01")?.id).toBe("board_abc");
    expect(findTaskByKeyOrId(items, "deco-1")?.id).toBe("board_abc");
    expect(findTaskByKeyOrId(items, "12")?.id).toBe("board_def");
  });

  test("resolves a raw id — what a keyless card's share link carries", () => {
    expect(findTaskByKeyOrId(items, "board_ghi")?.id).toBe("board_ghi");
  });

  /**
   * Regression for the collision `matchesTaskKey` was hardened against in
   * task-filters.tsx: a synced card's tracker key must resolve to the card
   * that actually wears it, not to whichever unrelated card happens to hold
   * the same number as a Studio `keySeq`.
   */
  test("resolves a synced card by its tracker key, not by a same-numbered keySeq", () => {
    expect(findTaskByKeyOrId(items, "OS-333")?.id).toBe("board_mno");
    expect(findTaskByKeyOrId(items, "os-333")?.id).toBe("board_mno");
  });

  test("misses cleanly", () => {
    expect(findTaskByKeyOrId(items, "DECO-99")).toBeUndefined();
    expect(findTaskByKeyOrId(items, "board_nope")).toBeUndefined();
    expect(findTaskByKeyOrId(items, "")).toBeUndefined();
    expect(findTaskByKeyOrId(items, undefined)).toBeUndefined();
  });
});
