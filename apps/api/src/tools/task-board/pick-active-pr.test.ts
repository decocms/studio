/**
 * Which linked PR the automation acts on. `listPrs` is newest-first and every
 * caller used to take `[0]`, which stranded a real card: a bounce opened PR
 * #327 instead of pushing to the reviewed #325, #327 was closed with a red
 * check, and the merge gate then reported `checks_failing` every five minutes
 * for a day while #325 sat approved, green and open. Pure; the GitHub read
 * itself is e2e.
 */

import { describe, expect, it } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItemPrRef } from "@/storage/types";
import { pickActivePr, pickActivePrIndex } from "./prs-get";

/** Throws on any access — proves a code path never touches `ctx`. */
const UNTOUCHABLE_CTX = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`pickActivePr must not read ctx.${String(prop)}`);
    },
  },
) as StudioContext;

const pr = (number: number): TaskBoardItemPrRef => ({
  repoOwner: "deco",
  repoName: "studio",
  number,
  url: `https://github.com/deco/studio/pull/${number}`,
  connectionId: "conn_1",
  createdAt: new Date(0).toISOString(),
});

describe("pickActivePrIndex", () => {
  it("takes the newest PR when it is open", () => {
    expect(pickActivePrIndex(["open"])).toBe(0);
    expect(pickActivePrIndex(["open", "closed"])).toBe(0);
  });

  it("skips a closed newest PR for the newest open one — the stranded card", () => {
    expect(pickActivePrIndex(["closed", "open"])).toBe(1);
    expect(pickActivePrIndex(["closed", "closed", "open"])).toBe(2);
  });

  // A GitHub blip must not silently redirect a merge to an older PR.
  it("treats an unreadable PR as usable, not as closed", () => {
    expect(pickActivePrIndex([null])).toBe(0);
    expect(pickActivePrIndex([null, "open"])).toBe(0);
    expect(pickActivePrIndex(["closed", null, "open"])).toBe(1);
  });

  it("falls back to the newest when every PR read closed", () => {
    expect(pickActivePrIndex(["closed"])).toBe(0);
    expect(pickActivePrIndex(["closed", "closed"])).toBe(0);
  });

  it("holds for an empty read — the caller indexes an empty list to undefined", () => {
    expect(pickActivePrIndex([])).toBe(0);
  });
});

describe("pickActivePr", () => {
  // The multi-PR read must go through the rate-limited queue, not straight at GitHub.
  it("never reads ctx — the multi-PR read goes through the throttled queue", async () => {
    await expect(
      pickActivePr(UNTOUCHABLE_CTX, "org_1", [pr(2), pr(1)]),
    ).resolves.toBeDefined();
  });

  it("skips the read entirely for a single linked PR", async () => {
    const only = pr(1);
    await expect(pickActivePr(UNTOUCHABLE_CTX, "org_1", [only])).resolves.toBe(
      only,
    );
  });
});
