/**
 * Regression coverage for `prCardActions`: the PR card used to offer "Ship to
 * production" whenever the task was reviewed-and-ready, ignoring mergeability —
 * so a PR that conflicts with its base branch got an optimistic green Ship
 * button whose merge would 405. The card must offer "Resolve conflict" there
 * instead.
 */
import { describe, expect, it } from "bun:test";
import { prCardActions } from "./pr-card-actions";
import type { TaskBoardItemPr } from "./config";

function pr(overrides: Partial<TaskBoardItemPr> = {}): TaskBoardItemPr {
  return {
    url: "https://github.com/o/r/pull/1",
    number: 1,
    repoOwner: "o",
    repoName: "r",
    createdAt: "2026-01-01T00:00:00.000Z",
    title: "A PR",
    body: null,
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    checksStatus: "passing",
    checks: [],
    previewUrl: null,
    ...overrides,
  };
}

describe("prCardActions", () => {
  it("offers Ship for a reviewed, open, clean, green PR", () => {
    const a = prCardActions(pr(), true);
    expect(a.showShip).toBe(true);
    expect(a.showResolveConflict).toBe(false);
    expect(a.hasConflict).toBe(false);
  });

  it("swaps Ship for Resolve conflict when the PR conflicts", () => {
    const a = prCardActions(pr({ mergeable: false }), true);
    expect(a.showShip).toBe(false);
    expect(a.showResolveConflict).toBe(true);
    expect(a.hasConflict).toBe(true);
  });

  it("does not treat unknown mergeability (null) as a conflict", () => {
    const a = prCardActions(pr({ mergeable: null }), true);
    expect(a.hasConflict).toBe(false);
    expect(a.showResolveConflict).toBe(false);
    expect(a.showShip).toBe(true);
  });

  it("offers neither action until the task is reviewed-and-ready", () => {
    expect(
      prCardActions(pr({ mergeable: false }), false).showResolveConflict,
    ).toBe(false);
    expect(prCardActions(pr(), false).showShip).toBe(false);
  });

  it("offers neither action on a merged or closed PR", () => {
    expect(prCardActions(pr({ merged: true }), true).showShip).toBe(false);
    expect(
      prCardActions(pr({ state: "closed", mergeable: false }), true)
        .showResolveConflict,
    ).toBe(false);
  });

  it("still offers Ship over pending checks, but never over failing ones", () => {
    expect(prCardActions(pr({ checksStatus: "pending" }), true).showShip).toBe(
      true,
    );
    expect(prCardActions(pr({ checksStatus: "failing" }), true).showShip).toBe(
      false,
    );
  });

  it("offers Resolve conflict even when checks are green (checks pass, merge conflicts)", () => {
    const a = prCardActions(
      pr({ mergeable: false, checksStatus: "passing" }),
      true,
    );
    expect(a.showResolveConflict).toBe(true);
    expect(a.showShip).toBe(false);
  });
});
