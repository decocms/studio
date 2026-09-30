import { describe, expect, it } from "bun:test";
import type { JiraStatusChange } from "./client";
import { SETTLE_MS, settle } from "./settle";

const T0 = Date.parse("2026-09-29T12:00:00Z");
const MIN = 60_000;

let nextId = 100;
/** A move into `to` at `at`, from the status the previous move entered. */
function moves(...steps: Array<[at: number, to: string]>): JiraStatusChange[] {
  let from = "Backlog";
  return steps.map(([at, to]) => {
    const change: JiraStatusChange = {
      id: String(nextId++),
      at,
      by: { accountId: "acc-ana", displayName: "Ana" },
      fromId: `s-${from}`,
      from,
      toId: `s-${to}`,
      to,
    };
    from = to;
    return change;
  });
}

describe("settle", () => {
  it("reacts to a move once the card stayed put, from where it rested", () => {
    const changes = moves([T0, "Doing"], [T0 + 30 * MIN, "Review"]);
    const settled = settle(changes, { now: T0 + 32 * MIN });
    expect(settled).toMatchObject({
      kind: "moved",
      change: { to: "Review" },
      from: { id: "s-Doing", name: "Doing" },
    });
  });

  it("waits while the latest move is younger than the settle window", () => {
    const changes = moves([T0, "Doing"]);
    expect(settle(changes, { now: T0 + SETTLE_MS - 1 })?.kind).toBe("moving");
    expect(settle(changes, { now: T0 + SETTLE_MS })?.kind).toBe("moved");
  });

  /** The drag that went wrong: into Review by mistake, straight back. */
  it("is a no-op when the card went away and back without resting", () => {
    const changes = moves(
      [T0, "Doing"],
      [T0 + 20 * MIN, "Review"],
      [T0 + 20 * MIN + 10_000, "Doing"],
    );
    const [, stray, back] = changes;
    // The stray drop is superseded; the move back returned to where it was.
    expect(settle(changes, { changeId: stray?.id })?.kind).toBe("superseded");
    expect(settle(changes, { changeId: back?.id })).toMatchObject({
      kind: "returned",
    });
  });

  it("skips a status the card only passed through on its way", () => {
    const changes = moves(
      [T0, "Doing"],
      [T0 + 20 * MIN, "Review"],
      [T0 + 20 * MIN + 5_000, "QA"],
    );
    expect(settle(changes, { now: T0 + 30 * MIN })).toMatchObject({
      kind: "moved",
      change: { to: "QA" },
      from: { name: "Doing" },
    });
  });

  it("counts the status an issue was created in as rested", () => {
    const changes = moves([T0, "Doing"], [T0 + 10_000, "Review"]);
    expect(settle(changes, { now: T0 + 5 * MIN })).toMatchObject({
      kind: "moved",
      from: { id: "s-Backlog", name: "Backlog" },
    });
  });

  it("compares by name when Jira gave no status ids", () => {
    const changes = moves(
      [T0, "Doing"],
      [T0 + 20 * MIN, "Review"],
      [T0 + 20 * MIN + 10_000, "Doing"],
    ).map((c) => ({ ...c, fromId: null, toId: null }));
    expect(settle(changes, { now: T0 + 30 * MIN })?.kind).toBe("returned");
  });

  it("trusts the caller's own wait when it passes no clock", () => {
    const changes = moves([T0, "Doing"]);
    expect(settle(changes, { changeId: changes[0]?.id })?.kind).toBe("moved");
  });

  it("has nothing to say about an issue that never moved", () => {
    expect(settle([], { now: T0 })).toBeNull();
  });
});
