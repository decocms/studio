import { describe, expect, test } from "bun:test";
import type { SandboxMap } from "@/sdk";
import { groupBranches, RECENT_WINDOW_MS } from "./group-branches";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** Minimal sandbox record — groupBranches only reads `createdAt`. */
const rec = (createdAt?: number) =>
  ({ sandboxHandle: "h", previewUrl: null, createdAt }) as unknown;

/** Build a SandboxMap[userId][branch] = { "agent-sandbox": rec } shape. */
function sandboxMap(
  entries: Record<string, Record<string, number | undefined>>,
): SandboxMap {
  const out: Record<string, unknown> = {};
  for (const [uid, branches] of Object.entries(entries)) {
    const byBranch: Record<string, unknown> = {};
    for (const [branch, createdAt] of Object.entries(branches)) {
      byBranch[branch] = { "agent-sandbox": rec(createdAt) };
    }
    out[uid] = byBranch;
  }
  return out as SandboxMap;
}

describe("groupBranches", () => {
  test("returns empty groups for empty/undefined sandbox map", () => {
    const result = groupBranches({
      sandboxMap: undefined,
      userId: "u1",
      rawBranches: [],
      now: NOW,
    });
    expect(result).toEqual({ recent: [], yours: [], others: [] });
  });

  test("github branches with no sandbox land in `others`", () => {
    const result = groupBranches({
      sandboxMap: undefined,
      userId: "u1",
      rawBranches: [
        { name: "main", author: "octocat" },
        { name: "feature", author: null },
      ],
      now: NOW,
    });
    expect(result.others.map((b) => b.name)).toEqual(["main", "feature"]);
    expect(result.others[0]?.author).toBe("octocat");
    expect(result.others[1]?.author).toBeNull();
  });

  test("recent = branches with sandbox activity inside the 7-day window, newest first", () => {
    const result = groupBranches({
      sandboxMap: sandboxMap({
        u1: { "branch-old": NOW - 8 * DAY, "branch-new": NOW - 1 * DAY },
        u2: { "branch-mid": NOW - 3 * DAY },
      }),
      userId: "u1",
      rawBranches: [],
      now: NOW,
    });
    // branch-old is outside the window -> excluded from recent
    expect(result.recent.map((b) => b.name)).toEqual([
      "branch-new",
      "branch-mid",
    ]);
    // branch-old (owned by u1) falls back to "yours"
    expect(result.yours.map((b) => b.name)).toEqual(["branch-old"]);
  });

  test("branch with no createdAt is excluded from recent but still shows in yours", () => {
    const result = groupBranches({
      sandboxMap: sandboxMap({ u1: { "no-ts": undefined } }),
      userId: "u1",
      rawBranches: [],
      now: NOW,
    });
    expect(result.recent).toEqual([]);
    expect(result.yours.map((b) => b.name)).toEqual(["no-ts"]);
  });

  test("exactly on the 7-day boundary counts as recent", () => {
    const result = groupBranches({
      sandboxMap: sandboxMap({ u1: { edge: NOW - RECENT_WINDOW_MS } }),
      userId: "u1",
      rawBranches: [],
      now: NOW,
    });
    expect(result.recent.map((b) => b.name)).toEqual(["edge"]);
  });

  test("a recent branch owned by the user appears only in recent, not yours", () => {
    const result = groupBranches({
      sandboxMap: sandboxMap({ u1: { hot: NOW - DAY } }),
      userId: "u1",
      rawBranches: [{ name: "hot", author: "someone" }],
      now: NOW,
    });
    expect(result.recent.map((b) => b.name)).toEqual(["hot"]);
    expect(result.yours).toEqual([]);
    // and it must not be duplicated into `others`
    expect(result.others).toEqual([]);
  });

  test("contributors are de-duplicated across users and take the max createdAt", () => {
    const result = groupBranches({
      sandboxMap: sandboxMap({
        u1: { shared: NOW - 5 * DAY },
        u2: { shared: NOW - 2 * DAY },
      }),
      userId: "u1",
      rawBranches: [],
      now: NOW,
    });
    expect(result.recent).toHaveLength(1);
    const branch = result.recent[0]!;
    expect(branch.name).toBe("shared");
    expect([...(branch.contributors ?? [])].sort()).toEqual(["u1", "u2"]);
    expect(branch.lastActiveAt).toBe(NOW - 2 * DAY);
  });

  test("others excludes both your-sandbox and recent branches", () => {
    const result = groupBranches({
      sandboxMap: sandboxMap({
        u1: { mine: NOW - 40 * DAY, "mine-recent": NOW - DAY },
      }),
      userId: "u1",
      rawBranches: [
        { name: "mine" },
        { name: "mine-recent" },
        { name: "external" },
      ],
      now: NOW,
    });
    expect(result.others.map((b) => b.name)).toEqual(["external"]);
    expect(result.yours.map((b) => b.name)).toEqual(["mine"]);
    expect(result.recent.map((b) => b.name)).toEqual(["mine-recent"]);
  });
});
