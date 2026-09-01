/**
 * `shippedPatch` is the one place every ship/archive route builds its status
 * write — pure, so unit-tested directly rather than through a fake ctx.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { BoardHandler } from "./board-handler";
import { boardCan, canAdvance, shippedPatch } from "./board-handler";

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

describe("canAdvance", () => {
  const board = (...keys: string[]) =>
    keys.map((key, position) => ({
      key,
      title: key,
      position,
      role: null,
      trackerStatuses: [],
    }));

  /**
   * The set this replaced was `{triage, todo, in_progress}` — every lane at or
   * before in_progress. Position reproduces it exactly on Studio's board,
   * which is what makes swapping the two a refactor for anyone not mirroring.
   */
  it("matches the lanes the hardcoded set held, on Studio's board", () => {
    const studio = board(
      "triage",
      "todo",
      "in_progress",
      "in_review",
      "approved",
      "merged",
      "post_deploy_validation",
      "done",
      "archived",
    );
    const advanceable = studio
      .map((c) => c.key)
      .filter((key) => canAdvance(studio, key, "in_progress"));
    expect(advanceable).toEqual(["triage", "todo", "in_progress"]);
  });

  /** The point of the change: a tracker's own order answers the same question
   *  for columns Studio never named. */
  it("answers by the tracker's order on a mirrored board", () => {
    const jira = board("Backlog", "Fazendo", "Code Review", "Deploy");
    expect(canAdvance(jira, "Backlog", "Fazendo")).toBe(true);
    expect(canAdvance(jira, "Fazendo", "Fazendo")).toBe(true);
    expect(canAdvance(jira, "Code Review", "Fazendo")).toBe(false);
    expect(canAdvance(jira, "Deploy", "Fazendo")).toBe(false);
  });

  /** A card in a column the board does not have is not one to move — the same
   *  answer every other lane decision gives for an unplaceable card. */
  it("refuses a column this board does not have, either end", () => {
    const jira = board("Backlog", "Fazendo");
    expect(canAdvance(jira, "triage", "Fazendo")).toBe(false);
    expect(canAdvance(jira, "Backlog", "in_progress")).toBe(false);
  });
});
