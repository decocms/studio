import { describe, expect, test } from "bun:test";
import {
  EMPTY_RAIL_ORG_PREFS,
  arrangeRailOrgs,
  hideRailOrg,
  moveRailOrg,
  readRailOrgPrefs,
  toggleRailOrgPin,
} from "./rail-org-prefs";
import { railOrgs } from "./recent-orgs";

const orgs = (...slugs: string[]) => slugs.map((slug) => ({ slug }));
const slugs = (list: { slug: string }[]) => list.map((o) => o.slug);

describe("readRailOrgPrefs", () => {
  test("survives junk", () => {
    expect(readRailOrgPrefs(null)).toEqual(EMPTY_RAIL_ORG_PREFS);
    expect(readRailOrgPrefs({ hidden: "a", pinned: [1, "b"] })).toEqual({
      hidden: [],
      pinned: ["b"],
      order: [],
    });
  });
});

describe("pin and hide", () => {
  test("hiding unpins, pinning unhides", () => {
    const pinned = toggleRailOrgPin(EMPTY_RAIL_ORG_PREFS, "a");
    expect(hideRailOrg(pinned, "a")).toEqual({
      hidden: ["a"],
      pinned: [],
      order: [],
    });
    expect(
      toggleRailOrgPin(hideRailOrg(EMPTY_RAIL_ORG_PREFS, "a"), "a"),
    ).toEqual({
      hidden: [],
      pinned: ["a"],
      order: [],
    });
  });
});

describe("arrangeRailOrgs", () => {
  const all = orgs("a", "b", "c", "d");

  test("pinned first, then dragged order, then the list's", () => {
    const prefs = { hidden: [], pinned: ["d"], order: ["c", "a"] };
    expect(slugs(arrangeRailOrgs(all, prefs, null))).toEqual([
      "d",
      "c",
      "a",
      "b",
    ]);
  });

  test("drops hidden orgs but never the current one", () => {
    const prefs = { hidden: ["a", "b"], pinned: [], order: [] };
    expect(slugs(arrangeRailOrgs(all, prefs, "b"))).toEqual(["b", "c", "d"]);
  });
});

describe("moveRailOrg", () => {
  const prefs = { hidden: [], pinned: ["a"], order: ["z"] };

  test("moves within a group and keeps other stored slugs", () => {
    expect(moveRailOrg(prefs, ["a", "b", "c"], "c", "b").order).toEqual([
      "a",
      "c",
      "b",
      "z",
    ]);
  });

  test("refuses a drag across the pinned boundary", () => {
    expect(moveRailOrg(prefs, ["a", "b", "c"], "b", "a")).toBe(prefs);
  });
});

describe("pinned orgs on a full rail", () => {
  test("stay even when history would not pick them", () => {
    const all = orgs("a", "b", "c", "d", "e");
    expect(slugs(railOrgs(all, ["a", "b"], "a", 3, ["e"]).shown)).toEqual([
      "a",
      "b",
      "e",
    ]);
  });
});
