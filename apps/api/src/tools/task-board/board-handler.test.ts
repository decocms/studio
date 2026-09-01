/**
 * `shippedPatch` is the one place every ship/archive route builds its status
 * write — pure, so unit-tested directly rather than through a fake ctx.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { BoardHandler } from "./board-handler";
import { boardCan, shippedPatch } from "./board-handler";

const boardWithOwner = (columnOwner: string | null): BoardHandler =>
  ({ columnOwner: () => columnOwner }) as BoardHandler;

describe("shippedPatch", () => {
  it("leaves boardColumnOrg null on Studio's own board", () => {
    expect(shippedPatch(boardWithOwner(null), "done")).toEqual({
      status: "done",
      boardColumnOrg: null,
    });
  });

  // The guard that #6725/#6739 each had to add by hand at their own call site.
  it("carries the org discriminator on an org-owned board", () => {
    expect(shippedPatch(boardWithOwner("org-1"), "merged")).toEqual({
      status: "merged",
      boardColumnOrg: "org-1",
    });
  });
});

describe("boardCan", () => {
  const warns: string[] = [];
  const original = console.warn;
  beforeEach(() => {
    warns.length = 0;
    console.warn = (msg: string) => warns.push(msg);
  });
  afterEach(() => {
    console.warn = original;
  });

  it("passes a lane through and says nothing", () => {
    expect(boardCan("org-quiet", "in_review", "Code Review", "reviewing")).toBe(
      true,
    );
    expect(warns).toEqual([]);
  });

  it("names the meaning and what will not happen", () => {
    expect(
      boardCan("org-a", "in_review", null, "automatic conflict resolution"),
    ).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("in_review");
    expect(warns[0]).toContain("automatic conflict resolution");
  });

  /**
   * The reason this is not a bare `console.warn`. These sit on sweep and sync
   * paths that fire every few seconds, so an unconfigured board would bury the
   * log it is trying to write.
   */
  it("warns once per org and meaning, not once per call", () => {
    for (let i = 0; i < 5; i++) boardCan("org-b", "todo", null, "delegating");
    expect(warns).toHaveLength(1);

    // A different meaning on the same board is a different thing to fix.
    boardCan("org-b", "in_progress", null, "moving the card");
    expect(warns).toHaveLength(2);

    // And another org's board is another team's problem to hear about.
    boardCan("org-c", "todo", null, "delegating");
    expect(warns).toHaveLength(3);
  });
});
