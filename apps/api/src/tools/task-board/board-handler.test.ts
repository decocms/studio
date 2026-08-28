import { describe, expect, it } from "bun:test";
import { CANONICAL_COLUMN_KEYS } from "@decocms/shared/task-board";
import { boardHandler } from "./board-handler";
import { LANE_RANK } from "./lanes";

/**
 * The seam automation asks instead of comparing `status` to a literal.
 *
 * One board is behind it today; what these pin is the contract the second one
 * has to honour. Above all that a column can be uneventful — a board mirrored
 * from someone else's tracker will have mostly columns nobody configured, and
 * a caller that assumes every column means something is the bug.
 */
describe("boardHandler — the board Studio ships with", () => {
  const board = boardHandler("org_1");

  it("renders every canonical column, left to right", async () => {
    expect((await board.columns()).map((c) => c.key)).toEqual([
      ...CANONICAL_COLUMN_KEYS,
    ]);
  });

  /** Position and rank are one ordering read two ways; if they drift, a card
   *  is "left of" something and "right of" it at once. */
  it("orders columns the way the forward-only guard ranks them", async () => {
    for (const column of await board.columns()) {
      expect(column.position).toBe(
        LANE_RANK[column.key as keyof typeof LANE_RANK],
      );
    }
  });

  it("starts work on the To Do lane", async () => {
    expect(await board.startsWorkOn("todo")).toBe(true);
  });

  it("starts work nowhere else, including a column it does not have", async () => {
    for (const key of CANONICAL_COLUMN_KEYS.filter((k) => k !== "todo")) {
      expect(await board.startsWorkOn(key)).toBe(false);
    }
    expect(await board.startsWorkOn("code_review")).toBe(false);
    expect(await board.startsWorkOn("")).toBe(false);
  });
});
