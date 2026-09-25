import { describe, expect, test } from "bun:test";
import { pushRecentOrg, railOrgs } from "./recent-orgs";

const orgs = (...slugs: string[]) => slugs.map((slug) => ({ slug }));
const slugs = (list: { slug: string }[]) => list.map((o) => o.slug);

describe("pushRecentOrg", () => {
  test("newest first", () => {
    expect(pushRecentOrg(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });

  test("reopening moves rather than duplicates", () => {
    expect(pushRecentOrg(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });

  test("trims to the limit", () => {
    expect(pushRecentOrg(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });
});

describe("railOrgs", () => {
  test("shows everything when the list already fits", () => {
    const all = orgs("a", "b", "c");
    const { shown, hidden } = railOrgs(all, [], "a", 10);
    expect(slugs(shown)).toEqual(["a", "b", "c"]);
    expect(hidden).toEqual([]);
  });

  test("caps at the limit and reports the rest as hidden", () => {
    const all = orgs("a", "b", "c", "d", "e");
    const { shown, hidden } = railOrgs(all, [], "a", 3);
    expect(shown).toHaveLength(3);
    expect(hidden).toHaveLength(2);
  });

  /** The point of the split: recency decides membership, not position. */
  test("draws the set in the list's own order, not recency order", () => {
    const all = orgs("a", "b", "c", "d");
    const { shown } = railOrgs(all, ["d", "c"], "a", 3);
    expect(slugs(shown)).toEqual(["a", "c", "d"]);
  });

  test("the current org is always shown, even with no history", () => {
    const all = orgs("a", "b", "c", "d", "e");
    const { shown } = railOrgs(all, [], "e", 2);
    expect(slugs(shown)).toContain("e");
  });

  test("history for an org you no longer belong to is ignored", () => {
    const all = orgs("a", "b", "c");
    const { shown } = railOrgs(all, ["gone", "c"], null, 2);
    expect(slugs(shown)).toEqual(["a", "c"]);
  });

  /** A fresh profile has no history and should still get a full rail. */
  test("fills from list order when history is short", () => {
    const all = orgs("a", "b", "c", "d", "e");
    const { shown } = railOrgs(all, ["e"], null, 3);
    expect(slugs(shown)).toEqual(["a", "b", "e"]);
  });
});
